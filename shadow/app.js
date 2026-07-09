const state = {
  pin: localStorage.getItem("shadowPin") || "",
  patients: [],
  currentKey: "",
};

const el = {
  status: document.querySelector("#status"),
  pin: document.querySelector("#pin"),
  savePin: document.querySelector("#savePin"),
  doctorId: document.querySelector("#doctorId"),
  loadWard: document.querySelector("#loadWard"),
  patientQuery: document.querySelector("#patientQuery"),
  loadSummary: document.querySelector("#loadSummary"),
  roster: document.querySelector("#roster"),
  clearPatients: document.querySelector("#clearPatients"),
  patientTabs: document.querySelector("#patientTabs"),
  resultPanel: document.querySelector("#resultPanel"),
};

el.pin.value = state.pin;
setStatus(state.pin ? "PIN 已儲存" : "等待登入");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(text) {
  el.status.textContent = text;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      "x-shadow-pin": state.pin,
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `API ${response.status}`);
  return payload;
}

async function createRequest(type, payload) {
  if (!state.pin) throw new Error("請先輸入 PIN。");
  const request = await api("/api/shadow/request", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
  return pollResult(request.id);
}

async function pollResult(id) {
  renderPending(id);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await api(`/api/shadow/result/${encodeURIComponent(id)}`);
    if (result.status === "done") return result.result;
    if (result.status === "error") throw new Error(result.error || "院內 relay 查詢失敗。");
    setStatus(`等待院內 relay 回傳... ${attempt + 1}`);
    await sleep(2000);
  }
  throw new Error("等待逾時，請確認院內 Shadow Relay Agent 是否啟動。");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadWard() {
  const doctorId = el.doctorId.value.trim();
  if (!doctorId) return;
  setBusy(true);
  try {
    setStatus("建立醫師清單 request...");
    const result = await createRequest("ward", { doctorId });
    renderWard(result);
    setStatus("醫師清單已更新");
  } catch (error) {
    renderError(error);
  } finally {
    setBusy(false);
  }
}

async function loadSummary(query) {
  const value = String(query || el.patientQuery.value || "").trim();
  if (!value) return;
  setBusy(true);
  try {
    setStatus(`查詢 ${value}...`);
    const result = await createRequest("summary", { query: value });
    renderSummary(result);
    setStatus("摘要已更新");
  } catch (error) {
    renderError(error);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  el.loadWard.disabled = busy;
  el.loadSummary.disabled = busy;
}

function renderWard(result) {
  const roster = result.roster || {};
  const patients = roster.patients || [];
  el.resultPanel.innerHTML = `
    <div class="result-header">
      <div>
        <h2>${escapeHtml(roster.physician?.id || "")} ${escapeHtml(roster.physician?.name || "")}</h2>
        <p class="muted">${escapeHtml(roster.message || result.text || "")}</p>
      </div>
      <span class="badge">${patients.length} 位</span>
    </div>
  `;
  state.patients = patients.map((patient) => ({
    key: patient.chartNo || patient.bedNo || patient.feeNo,
    patient,
    summary: null,
  })).filter((item) => item.key);
  renderRoster();
  renderTabs();
}

function renderRoster() {
  if (!state.patients.length) {
    el.roster.innerHTML = `<div class="empty">尚無病人清單。</div>`;
    return;
  }
  el.roster.innerHTML = state.patients.map(({ key, patient }) => `
    <button class="patient-item" type="button" data-query="${escapeHtml(key)}">
      <strong>${escapeHtml(patient.name || patient.chartNo || key)} · ${escapeHtml(patient.bedNo || "床號待讀取")}</strong>
      <span>${escapeHtml([patient.chartNo, patient.dept].filter(Boolean).join(" · "))}</span>
    </button>
  `).join("");
}

function renderSummary(result) {
  const patient = result.patient || {};
  const key = patient.chartNo || patient.patientRef || patient.bedNo || result.query || "";
  if (key) {
    const existing = state.patients.find((item) => item.key === key);
    if (existing) existing.summary = result;
    else state.patients.unshift({ key, patient, summary: result });
    state.currentKey = key;
  }
  renderTabs();
  renderSummaryPanel(result);
}

function renderSummaryPanel(result) {
  const patient = result.patient || {};
  const bed = patient.bedNo ? `床 ${patient.bedNo}` : "";
  el.resultPanel.innerHTML = `
    <div class="result-header">
      <div>
        <h2>${escapeHtml(patient.chartNo || patient.patientRef || "病人摘要")} ${escapeHtml(patient.displayName || "")}</h2>
        <p class="muted">${escapeHtml([bed, patient.updatedAt ? new Date(patient.updatedAt).toLocaleString("zh-TW", { hour12: false }) : ""].filter(Boolean).join(" · "))}</p>
      </div>
      <span class="badge">摘要</span>
    </div>
    <pre class="summary-text">${escapeHtml(result.text || "尚無摘要文字。")}</pre>
  `;
}

function renderTabs() {
  el.patientTabs.innerHTML = state.patients.map((item) => `
    <button class="patient-tab ${item.key === state.currentKey ? "is-active" : ""}" type="button" data-tab-key="${escapeHtml(item.key)}">
      ${escapeHtml(item.patient?.name || item.patient?.displayName || item.patient?.chartNo || item.key)}
    </button>
  `).join("");
}

function renderPending(id) {
  el.resultPanel.innerHTML = `
    <div class="result-header">
      <div>
        <h2>等待院內 relay</h2>
        <p class="muted">Request ID：${escapeHtml(id)}</p>
      </div>
      <span class="badge pending">Pending</span>
    </div>
  `;
}

function renderError(error) {
  setStatus("查詢失敗");
  el.resultPanel.innerHTML = `<div class="empty">查詢失敗：${escapeHtml(error.message || error)}</div>`;
}

el.savePin.addEventListener("click", () => {
  state.pin = el.pin.value.trim();
  localStorage.setItem("shadowPin", state.pin);
  setStatus(state.pin ? "PIN 已儲存" : "等待登入");
});

el.loadWard.addEventListener("click", loadWard);
el.loadSummary.addEventListener("click", () => loadSummary());
el.clearPatients.addEventListener("click", () => {
  state.patients = [];
  state.currentKey = "";
  renderRoster();
  renderTabs();
});

el.roster.addEventListener("click", (event) => {
  const query = event.target.closest("[data-query]")?.dataset?.query;
  if (query) loadSummary(query);
});

el.patientTabs.addEventListener("click", (event) => {
  const key = event.target.closest("[data-tab-key]")?.dataset?.tabKey;
  if (!key) return;
  const item = state.patients.find((patient) => patient.key === key);
  if (!item) return;
  state.currentKey = key;
  renderTabs();
  if (item.summary) renderSummaryPanel(item.summary);
  else loadSummary(key);
});
