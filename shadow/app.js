const state = {
  currentPatient: null,
  currentTab: "summary",
  user: null,
  pin: localStorage.getItem("shadowPin") || "",
  physicianRoster: [],
  physicianRosterDoctor: null,
  openPatients: [],
  labHistoryLoading: false,
  detailLoadingKey: "",
  patientSwitcherExpanded: false,
};

const el = {
  serviceStatus: document.querySelector("#serviceStatus"),
  searchForm: document.querySelector("#searchForm"),
  patientQuery: document.querySelector("#patientQuery"),
  recentList: document.querySelector("#recentList"),
  recentStatus: document.querySelector("#recentStatus"),
  reloadRecent: document.querySelector("#reloadRecent"),
  physicianRosterForm: document.querySelector("#physicianRosterForm"),
  physicianQuery: document.querySelector("#physicianQuery"),
  physicianRosterStatus: document.querySelector("#physicianRosterStatus"),
  physicianRosterList: document.querySelector("#physicianRosterList"),
  openRosterPatients: document.querySelector("#openRosterPatients"),
  refreshRosterPatients: document.querySelector("#refreshRosterPatients"),
  loginForm: document.querySelector("#loginForm"),
  loginUser: document.querySelector("#loginUser"),
  loginPassword: document.querySelector("#loginPassword"),
  loginMessage: document.querySelector("#loginMessage"),
  userPanel: document.querySelector("#userPanel"),
  currentUserLabel: document.querySelector("#currentUserLabel"),
  logoutButton: document.querySelector("#logoutButton"),
  patientTitle: document.querySelector("#patientTitle"),
  patientMeta: document.querySelector("#patientMeta"),
  patientWindowTabs: document.querySelector("#patientWindowTabs"),
  refreshPatient: document.querySelector("#refreshPatient"),
  refreshOnepage: document.querySelector("#refreshOnepage"),
  disableShadowRelay: document.querySelector("#disableShadowRelay"),
  copySummary: document.querySelector("#copySummary"),
  warningStrip: document.querySelector("#warningStrip"),
  tabs: [...document.querySelectorAll(".tab")],
  panels: [...document.querySelectorAll("[data-panel]")],
};

if (el.loginUser) el.loginUser.value = state.pin;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function displayText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join("；");
  if (typeof value === "object") {
    for (const key of ["label", "text", "diagnosis", "admissionReason", "title", "name", "value"]) {
      const text = displayText(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

async function api(path, options = {}) {
  if (path === "/api/health") return { ok: true, mode: "shadow" };

  if (path === "/api/auth/me") {
    if (!state.pin) throw new Error("尚未輸入 PIN");
    return { user: shadowUser() };
  }

  if (path === "/api/auth/login") {
    const body = parseJsonBody(options.body);
    const pin = String(body.username || body.pin || "").trim();
    if (!pin) throw new Error("請輸入影子工作站 PIN。");
    state.pin = pin;
    localStorage.setItem("shadowPin", pin);
    return { user: shadowUser() };
  }

  if (path === "/api/auth/logout") {
    state.pin = "";
    localStorage.removeItem("shadowPin");
    return { ok: true };
  }

  if (path === "/api/patients/recent") {
    return { patients: loadShadowRecent() };
  }

  if (path === "/api/patients/search" || path === "/api/patients/refresh") {
    const body = parseJsonBody(options.body);
    const query = body.query || body.patientRef || body.chartNo;
    if (!query) throw new Error("請輸入病歷號、床號或住院序號。");
    return requestShadowPatient(query, {
      mode: path === "/api/patients/refresh" ? "full" : (["quick", "details"].includes(body.mode) ? body.mode : "full"),
      forceRefresh: path === "/api/patients/refresh" || body.forceRefresh === true,
    });
  }

  if (path === "/api/physicians/inpatients") {
    const body = parseJsonBody(options.body);
    const doctorId = body.doctorId || body.query;
    if (!doctorId) throw new Error("請輸入醫師員工編號。");
    const result = await createShadowRequest("ward", { doctorId });
    const roster = result.roster || {};
    return {
      physician: roster.physician || { id: doctorId },
      patients: roster.patients || [],
      message: roster.message || result.text || "",
    };
  }

  if (path === "/api/onepage/session-refresh") {
    return createShadowRequest("session_refresh", {});
  }

  if (path === "/api/shadow/relay-disable") {
    return createShadowRequest("relay_control", { action: "disable" });
  }

  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `API ${response.status}`);
  return payload;
}

function shadowUser() {
  return { username: "shadow", displayName: "影子工作站" };
}

function parseJsonBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

async function createShadowRequest(type, payload) {
  if (!state.pin) throw new Error("請先輸入影子工作站 PIN。");
  const cryptoState = await createCryptoState();
  payload.crypto = { ecdhPublicKey: cryptoState.publicKey, compression: cryptoState.compression };
  const request = await shadowFetch("/api/shadow/request", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
  return pollShadowResult(request.id, cryptoState.privateKey);
}

async function requestShadowPatient(query, options = {}) {
  const result = await createShadowRequest("summary", {
    query,
    mode: ["quick", "details"].includes(options.mode) ? options.mode : "full",
    ...(Array.isArray(options.sources) && options.sources.length ? { sources: options.sources } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
  const patient = normalizeShadowPatient(result, query);
  saveShadowRecent(patient);
  return patient;
}

async function refreshShadowOnepageSession() {
  if (!state.user) throw new Error("請先輸入影子工作站 PIN。");
  el.refreshOnepage.disabled = true;
  el.serviceStatus.textContent = "正在請院內主機重新連線 Onepage…";
  try {
    const result = await api("/api/onepage/session-refresh", { method: "POST", body: "{}" });
    if (!result?.ok || result.code !== "session_refreshed") throw new Error("院內主機無法重新連線 Onepage。");
    el.serviceStatus.textContent = "Onepage 已重新連線";
    el.patientMeta.textContent = "院內主機已刷新 Onepage session；可重新整理病人資料。";
  } catch (error) {
    const message = String(error?.message || "");
    el.serviceStatus.textContent = /cooling down/i.test(message) ? "Onepage 重新登入暫時冷卻中" : "Onepage 重新連線失敗";
    el.patientMeta.textContent = "院內主機未能刷新 session；請在院內主機確認 Onepage 憑證與 relay 狀態。";
    throw error;
  } finally {
    el.refreshOnepage.disabled = !state.user;
  }
}

async function disableShadowRelay() {
  if (!state.user) throw new Error("請先輸入影子工作站 PIN。");
  const confirmed = window.confirm("停止後院內主機將不再輪詢 Cloudflare，影子頁無法自行重新啟用。是否停止？");
  if (!confirmed) return;
  el.disableShadowRelay.disabled = true;
  el.disableShadowRelay.textContent = "停止中…";
  el.serviceStatus.textContent = "正在停止院內影子 relay…";
  try {
    const result = await api("/api/shadow/relay-disable", { method: "POST", body: "{}" });
    if (!result?.ok || result.code !== "shadow_relay_disabled") throw new Error("院內主機未確認影子 relay 已停止。");
    el.serviceStatus.textContent = "影子連線已停止";
    el.patientMeta.textContent = "院內主機已停止 Cloudflare polling；需在院內 LAN 工作台重新啟用。";
    el.disableShadowRelay.textContent = "影子連線已停止";
    el.refreshOnepage.disabled = true;
    el.refreshPatient.disabled = true;
  } catch (error) {
    el.disableShadowRelay.disabled = !state.user;
    el.disableShadowRelay.textContent = "停止影子連線";
    throw error;
  }
}

async function loadShadowLabHistory(offset = 0, range = {}) {
  if (!state.currentPatient || state.labHistoryLoading) return;
  state.labHistoryLoading = true;
  try {
    const query = state.currentPatient.patientRef || state.currentPatient.chartNo;
    const history = await createShadowRequest("labs", { query, offset, startDate: range.startDate || "", endDate: range.endDate || "" });
    Object.assign(state.currentPatient, history);
    state.currentPatient.labView = "matrix";
    renderPatient(state.currentPatient, { store: false });
    switchTab("labs");
  } finally {
    state.labHistoryLoading = false;
  }
}

async function loadShadowAllLabs() {
  if (!state.currentPatient || state.labHistoryLoading) return;
  state.labHistoryLoading = true;
  try {
    const query = state.currentPatient.patientRef || state.currentPatient.chartNo;
    const range = state.currentPatient.labHistory || {};
    const rows = [];
    let offset = 0;
    let firstPage = null;
    let page = null;
    do {
      page = await createShadowRequest("labs", { query, offset, startDate: range.startDate || "", endDate: range.endDate || "" });
      if (!firstPage) firstPage = page;
      rows.push(...(page.labs || []));
      offset += page.labHistory?.pageSize || 3;
      el.serviceStatus.textContent = `載入全部 Lab：${Math.min(offset, page.labHistory?.totalDates || offset)} / ${page.labHistory?.totalDates || offset}`;
    } while (page.labHistory?.hasOlder);
    const unique = new Map(rows.map((row) => [[row.time, row.item, row.latest, row.unit].join("|"), row]));
    Object.assign(state.currentPatient, firstPage || {}, { labHistoryAll: [...unique.values()], labView: "all" });
    renderPatient(state.currentPatient, { store: false });
    switchTab("labs");
  } finally {
    state.labHistoryLoading = false;
  }
}

async function pollShadowResult(id, privateKey = null) {
  el.serviceStatus.textContent = "等待院內主機 relay 回傳...";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await shadowFetch(`/api/shadow/result/${encodeURIComponent(id)}`);
    if (result.status === "done") {
      el.serviceStatus.textContent = "影子工作站已連線";
      return decryptResultIfNeeded(result.result, privateKey);
    }
    if (result.status === "error") {
      const decryptedError = await decryptResultIfNeeded(result.result, privateKey).catch(() => null);
      const code = decryptedError?.code || result.error || "relay_request_failed";
      if (code === "onepage_refresh_cooldown") el.serviceStatus.textContent = "Onepage 重新登入暫時冷卻中";
      else if (code === "onepage_credential_missing") el.serviceStatus.textContent = "院內主機尚未設定 Onepage 憑證";
      else if (code === "onepage_refresh_failed") el.serviceStatus.textContent = "Onepage 自動重新登入失敗";
      else el.serviceStatus.textContent = "院內 relay 無法完成查詢";
      throw new Error(decryptedError?.error || result.error || "院內 relay 回傳錯誤。");
    }
    if (result.status === "expired") {
      el.serviceStatus.textContent = "院內 relay 離線或未回覆";
      throw new Error("院內 relay 未在時限內回覆。");
    }
    await sleep(2000);
  }
  throw new Error("等待院內 relay 逾時，請確認 Shadow Relay Agent 仍在院內主機執行。");
}

async function createCryptoState() {
  if (!crypto?.subtle) return { privateKey: null, publicKey: "" };
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { privateKey: keyPair.privateKey, publicKey: base64UrlEncode(JSON.stringify(publicJwk)), compression: "gzip" };
}

async function decryptResultIfNeeded(result, privateKey) {
  if (!result?.encrypted) return result || {};
  if (!privateKey) throw new Error("此瀏覽器不支援影子工作站端對端解密。");
  const peerPublicKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(base64UrlDecode(result.ecdhPublicKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(result.iv) }, aesKey, base64UrlToBytes(result.ciphertext));
  const bytes = result.compression === "gzip"
    ? await decompressGzipBytes(new Uint8Array(plaintext))
    : new Uint8Array(plaintext);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function decompressGzipBytes(bytes) {
  if (!("DecompressionStream" in window)) {
    throw new Error("瀏覽器不支援 gzip 解壓縮，請更新 Chrome 後再試。");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64UrlEncode(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

function base64UrlToBytes(value) {
  const binary = base64UrlDecode(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function shadowFetch(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      "x-shadow-pin": state.pin,
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Shadow API ${response.status}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeShadowPatient(result, query) {
  const patient = { ...(result.patient || {}) };
  if (!patient.chartNo && !patient.patientRef) patient.patientRef = String(query || "");
  if (!patient.source) patient.source = "shadow";
  if (!patient.updatedAt) patient.updatedAt = new Date().toISOString();
  if (result.text) patient.shadowSummaryText = result.text;
  return patient;
}

function loadShadowRecent() {
  try {
    return JSON.parse(localStorage.getItem("shadowRecentPatients") || "[]");
  } catch {
    return [];
  }
}

function saveShadowRecent(patient) {
  const key = patientKey(patient);
  if (!key) return;
  const item = {
    patientRef: patient.patientRef || patient.chartNo || key,
    chartNo: patient.chartNo || patient.patientRef || key,
    displayName: patient.displayName || patient.name || patient.chartNo || key,
    bedNo: patient.bedNo || "",
    updatedAt: patient.updatedAt || new Date().toISOString(),
  };
  const next = [item, ...loadShadowRecent().filter((row) => (row.chartNo || row.patientRef) !== key)].slice(0, 20);
  localStorage.setItem("shadowRecentPatients", JSON.stringify(next));
}

function renderAuth() {
  const loggedIn = !!state.user;
  el.loginForm.classList.toggle("is-hidden", loggedIn);
  el.userPanel.classList.toggle("is-hidden", !loggedIn);
  el.patientQuery.disabled = !loggedIn;
  el.searchForm.querySelector("button").disabled = !loggedIn;
  el.physicianQuery.disabled = !loggedIn;
  el.physicianRosterForm.querySelector("button").disabled = !loggedIn;
  el.openRosterPatients.disabled = !loggedIn || !state.physicianRoster.length;
  el.refreshRosterPatients.disabled = !loggedIn || !state.physicianRoster.length;
  el.reloadRecent.disabled = !loggedIn;
  el.refreshOnepage.disabled = !loggedIn;
  el.disableShadowRelay.disabled = !loggedIn;
  if (loggedIn) {
    el.currentUserLabel.textContent = `${state.user.displayName || state.user.username} 已解鎖`;
  } else {
    el.currentUserLabel.textContent = "";
    el.loginMessage.textContent = "請輸入影子工作站 PIN；資料會透過 Discord relay 向院內主機請求。";
    renderPhysicianRoster([]);
  }
}

async function refreshAuth() {
  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
  } catch {
    state.user = null;
  }
  renderAuth();
}

function updateRecentStatus(text) {
  if (el.recentStatus) el.recentStatus.textContent = text;
}

function renderRecent(items) {
  el.recentList.innerHTML = "";
  if (!items.length) {
    el.recentList.innerHTML = `<div class="empty-state compact">尚無已擷取病人。</div>`;
    updateRecentStatus("清單目前沒有資料。重整只更新左側清單。");
    return;
  }

  for (const item of items) {
    const button = document.createElement("button");
    button.className = "patient-item";
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHtml(item.displayName || item.patientRef || "未命名")} · ${escapeHtml(item.bedNo || "待讀取")}</strong>
      <span>${formatTime(item.updatedAt)} 更新</span>
    `;
    button.addEventListener("click", () => loadPatient(item.patientRef));
    el.recentList.append(button);
  }
  const newest = items[0]?.updatedAt ? `最新資料 ${formatTime(items[0].updatedAt)} 更新` : "清單已更新";
  updateRecentStatus(`${newest}；重整只更新左側清單。`);
}

function renderPhysicianRoster(items = [], doctor = state.physicianRosterDoctor, statusText = "") {
  state.physicianRoster = items;
  state.physicianRosterDoctor = doctor;
  el.physicianRosterList.innerHTML = "";
  el.openRosterPatients.disabled = !state.user || !items.length;
  el.refreshRosterPatients.disabled = !state.user || !items.length;
  if (!state.user) {
    el.physicianRosterStatus.textContent = "請先輸入 PIN 後查詢醫師住院清單。";
    return;
  }
  if (!items.length) {
    el.physicianRosterStatus.textContent = statusText || (doctor?.id ? `${doctor.id}${doctor.name ? ` ${doctor.name}` : ""}：目前無住院清單。` : "輸入醫師員工編號後可快速列出住院病人。");
    el.physicianRosterList.innerHTML = `<div class="empty-state compact">尚無住院清單。</div>`;
    return;
  }

  el.physicianRosterStatus.textContent = `${doctor?.id || ""}${doctor?.name ? ` ${doctor.name}` : ""}：${items.length} 位住院病人`;
  for (const item of items) {
    const button = document.createElement("button");
    button.className = `patient-item roster-item${item.combineCare ? " is-combine-care" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHtml(item.name || item.chartNo || "未命名")} · ${escapeHtml(item.bedNo || "待讀取")}</strong>
      <span>${escapeHtml([item.chartNo, item.dept, item.admitDate ? `入院 ${shortDateLabel(item.admitDate)}` : "", item.combineCare ? "共照" : ""].filter(Boolean).join(" · "))}</span>
    `;
    button.addEventListener("click", () => loadPatient(item.chartNo || item.bedNo || item.feeNo));
    el.physicianRosterList.append(button);
  }
}

function patientKey(patient = {}) {
  return String(patient.chartNo || patient.patientRef || patient.feeno || patient.bedNo || "").trim();
}

function patientWindowLabel(patient = {}) {
  return [patient.displayName || patient.chartNo || patient.patientRef || "未命名", patient.bedNo || ""].filter(Boolean).join(" · ");
}

function patientWindowDetails(patient = {}) {
  return [patient.chartNo || patient.patientRef || "病歷號待讀取", patient.bedNo ? `床號 ${patient.bedNo}` : "床號待讀取"].join(" · ");
}

function admissionPeriodLabel(patient = {}) {
  const period = patient.admissionPeriod || {};
  const start = shortDateLabel(period.startDate);
  const end = shortDateLabel(period.endDate);
  if (start && end) return `${start} ~ ${end}（已出院）`;
  if (start) return `${start}（住院中）`;
  if (period.status === "discharged") return "已出院";
  if (period.status === "inpatient") return "住院中";
  return "";
}

function shortDateLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/(?:\d{4}[/-])?(\d{1,2})[/-](\d{1,2})/);
  if (match) return `${Number(match[1])}/${String(Number(match[2])).padStart(2, "0")}`;
  return text.split(/\s+/)[0];
}

function upsertOpenPatient(patient) {
  const key = patientKey(patient);
  if (!key) return;
  const previous = state.openPatients.filter((item) => patientKey(item) !== key);
  state.openPatients = [patient, ...previous].slice(0, 16);
}

function renderPatientWindows() {
  if (!el.patientWindowTabs) return;
  if (!state.openPatients.length) {
    el.patientWindowTabs.innerHTML = "";
    el.patientWindowTabs.classList.add("is-hidden");
    return;
  }
  const currentKey = patientKey(state.currentPatient);
  el.patientWindowTabs.classList.remove("is-hidden");
  const expanded = state.patientSwitcherExpanded;
  el.patientWindowTabs.innerHTML = `
    <div class="patient-window-toolbar">
      <span>已開啟病人 ${state.openPatients.length} 位</span>
      <button class="patient-window-toggle" type="button" data-toggle-patient-windows aria-expanded="${expanded}">${expanded ? "收合清單" : "展開清單"}</button>
    </div>
    <div class="patient-window-grid${expanded ? " is-expanded" : ""}"${expanded ? "" : " hidden"}>
      ${state.openPatients.map((patient) => {
    const key = patientKey(patient);
    return `
      <div class="patient-window-tab ${key === currentKey ? "is-active" : ""}" data-patient-key="${escapeHtml(key)}">
        <button class="patient-window-switch" type="button" data-patient-key="${escapeHtml(key)}">
          <strong>${escapeHtml(patientWindowLabel(patient))}</strong>
          <span>${escapeHtml(patientWindowDetails(patient))}</span>
        </button>
        <button class="patient-window-close" type="button" data-close-patient="${escapeHtml(key)}" title="關閉此病人">×</button>
      </div>
    `;
      }).join("")}
    </div>
  `;
}

function clearPatientView(message = "請先輸入影子工作站 PIN。") {
  state.currentPatient = null;
  el.patientTitle.textContent = "尚未選擇";
  el.patientMeta.textContent = message;
  el.refreshPatient.disabled = true;
  el.copySummary.disabled = true;
  el.warningStrip.classList.add("is-hidden");
  for (const panel of el.panels) panel.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  renderPatientWindows();
}

function renderPatient(patient, options = {}) {
  if (options.store !== false) upsertOpenPatient(patient);
  state.currentPatient = patient;
  renderPatientWindows();
  const bedLabel = patient.bedNo || "床號待讀取";
  el.patientTitle.innerHTML = `
    <span>${escapeHtml(patient.chartNo || patient.patientRef || "未指定")}</span>
    <span class="name-badge">${escapeHtml(patient.displayName || "姓名待讀取")}</span>
    <span class="bed-badge">${escapeHtml(bedLabel)}</span>
  `;

  const sourceLabel =
    patient.source === "demo" ? "示範資料" :
    patient.source === "pending" ? "尚未擷取" :
    patient.source === "shadow" ? "影子 relay" :
    patient.source === "missing_auth" ? "院內工作站 session 已失效" :
    "Onepage/NIS";
  el.patientMeta.textContent = `${patient.displayName || "待識別"} · ${sourceLabel} · ${formatTime(patient.updatedAt)} 更新 · 床號來源：${patient.bedNo ? patient.bedSource || "Profile" : "Profile 尚未擷取"}`;
  el.refreshPatient.disabled = false;
  el.copySummary.disabled = false;

  if (patient.warnings?.length) {
    el.warningStrip.textContent = patient.warnings.join(" · ");
    el.warningStrip.classList.remove("is-hidden");
  } else {
    el.warningStrip.classList.add("is-hidden");
  }

  document.querySelector("#summaryPanel").innerHTML = roundingSummary(patient);

  document.querySelector("#contextPanel").innerHTML = clinicalContext(patient.clinicalContext, patient.noteSources);
  document.querySelector("#notePanel").innerHTML = notePanel(patient);
  document.querySelector("#labsPanel").innerHTML = renderLabs(patient);
  document.querySelector("#imagingPanel").innerHTML = renderImaging(patient.imaging || []);
  document.querySelector("#surgeryPanel").innerHTML = renderSurgeries(patient.surgeries || []);
  document.querySelector("#pathologyPanel").innerHTML = renderPathology(patient.pathology || []);
  document.querySelector("#nursingPanel").innerHTML = renderNursing(patient.nursing || []);
  document.querySelector("#ordersPanel").innerHTML = renderOrders(patient.orders || []);
  document.querySelector("#tprPanel").innerHTML = renderTpr(patient.tpr || patient.vitals || patient.itpr || [], patient.intakeOutput);
  document.querySelector("#ioPanel").innerHTML = ioPanel(patient.intakeOutput);
  document.querySelector("#glucosePanel").innerHTML = renderGlucose(patient.glucose || [], sourceResult(patient, "glucose"));
}


function roundingSummary(patient) {
  const coverage = buildCoverage(patient);
  const structured = buildStructuredRoundingNote(patient, coverage);
  const sources = (patient.clinicalContext?.sourceExtracts || []);
  const sourceRows = sources.map((item) => [item.source, sourceBadge(item.status), item.lastResult || ""]);
  return `
    <section class="rounding-note primary-summary">
      <div class="section-title">
        <strong>查房摘要</strong>
        <button id="copyStructuredSummary" type="button">複製查房格式</button>
      </div>
      ${summaryClinicalTables(patient)}
      <pre class="summary-text">${escapeHtml(structured)}</pre>
    </section>
    <details class="rounding-overview" aria-label="查房總覽">
      <summary>資料擷取狀態</summary>
      <div class="rounding-heading">
        <div>
          <p class="eyebrow">查房總覽</p>
          <h3>${escapeHtml(patient.chartNo || patient.patientRef || "未指定")}${patient.bedNo ? ` · ${escapeHtml(patient.bedNo)}` : ""}</h3>
        </div>
      </div>
      <div class="coverage-grid">
        ${coverage.map((item) => `<article class="coverage-card status-${item.status}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong><small>${escapeHtml(item.detail)}</small></article>`).join("")}
      </div>
      <p class="eyebrow">${escapeHtml(patient.message || "")}</p>
    </details>
    <section class="source-status-panel">
      <h3>資料來源與擷取狀態</h3>
      ${table(["來源", "狀態", "最近結果"], sourceRows)}
    </section>
    ${patient.source === "missing_auth" ? `<div class="session-help"><strong>院內工作站 session 已失效</strong><p>請在院內主機重新登入 Onepage，再啟動 Shadow Relay Agent。</p></div>` : ""}
  `;
}

function buildCoverage(patient) {
  const has = (value) => Array.isArray(value) ? value.length > 0 : !!value;
  const tprRows = patientTprRows(patient);
  const assessment = patient.clinicalContext?.adultAdmissionAssessment;
  return [
    { label: "病人識別", value: patient.displayName && patient.displayName !== "待由 Onepage 識別" ? "已確認" : "待確認", detail: patient.bedNo ? patient.bedNo : "床號尚未讀取", status: patient.displayName && patient.displayName !== "待由 Onepage 識別" ? "ok" : "warn" },
    { label: "住院醫囑", value: has(patient.orders) ? `${patient.orders.length} 筆` : "尚未擷取", detail: has(patient.orders) ? "請至醫囑分頁核對 active / DC" : "需要 Onepage / NIS 資料", status: has(patient.orders) ? "ok" : "missing" },
    { label: "入院評估", value: assessment ? "已擷取" : "尚未擷取", detail: assessment?.admissionReason || "入院原因與病史", status: assessment ? "ok" : "missing" },
    { label: "TPR", value: has(tprRows) ? `${tprRows.length} 筆` : "尚未擷取", detail: has(tprRows) ? "已依時間由新到舊排列" : "不可視為正常", status: has(tprRows) ? "ok" : "missing" },
    { label: "Labs", value: has(patient.labs) ? `${patient.labs.length} 筆` : "尚未擷取", detail: has(patient.labs) ? latestLine(patient.labs, (row) => `${row.item || "Lab"} ${row.latest || ""}`) : "尚未讀取檢驗結果", status: has(patient.labs) ? "ok" : "missing" },
    { label: "影像", value: has(patient.imaging) ? `${patient.imaging.length} 筆` : "尚未擷取", detail: has(patient.imaging) ? latestLine(patient.imaging, (row) => `${row.date || ""} ${row.type || "影像"}`) : "尚未讀取報告結果", status: has(patient.imaging) ? "ok" : "missing" },
    { label: "手術", value: has(patient.surgeries) ? `${patient.surgeries.length} 筆` : "尚未擷取", detail: has(patient.surgeries) ? latestLine(patient.surgeries, (row) => row.procedure || row.note || "手術紀錄") : "尚未讀取手術紀錄", status: has(patient.surgeries) ? "ok" : "missing" },
    { label: "病理", value: has(patient.pathology) ? `${patient.pathology.length} 筆` : "尚未擷取", detail: has(patient.pathology) ? latestLine(patient.pathology, (row) => `${row.date || ""} ${row.type || "病理"}`) : "尚未讀取病理報告", status: has(patient.pathology) ? "ok" : "missing" },
    { label: "護理", value: has(patient.nursing) ? `${patient.nursing.length} 筆` : "尚未擷取", detail: has(patient.nursing) ? latestLine(patient.nursing, (row) => row.note || row.type || "護理紀錄") : "尚未讀取護理紀錄", status: has(patient.nursing) ? "ok" : "missing" },
  ];
}

function patientTprRows(patient = {}) {
  return [patient.tpr, patient.vitals, patient.itpr].find((rows) => Array.isArray(rows) && rows.length) || [];
}

function latestLine(rows, formatter) {
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!first) return "";
  return String(formatter(first) || "").slice(0, 80);
}

function sourceBadge(status) {
  const map = { ok: "已擷取", pending_parser: "待接 parser", error: "擷取失敗", queued: "待處理" };
  return map[status] || status || "未設定";
}

function buildStructuredRoundingNote(patient, coverage) {
  const assessment = patient.clinicalContext?.adultAdmissionAssessment || {};
  const lines = [
    `【查房摘要｜${patient.chartNo || patient.patientRef || "未指定"}${patient.bedNo ? `｜${patient.bedNo}` : ""}】`,
    `資料更新：${patient.updatedAt ? new Date(patient.updatedAt).toLocaleString("zh-TW", { hour12: false }) : "未提供"}`,
    `住院狀態：${admissionPeriodLabel(patient) || "尚未擷取"}`,
    `住院原因：${assessment.admissionReason || patient.clinicalContext?.admissionReason?.text || "尚未擷取"}`,
    `診斷：${diagnosisLine(patient)}`,
    `過去病史：${historyLine(patient)}`,
    "Plan：請依原始病歷、當日病程與醫囑完成最終臨床判讀。",
  ];
  return lines.join("\n");
}

function todayKeys() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return { yyyy, mm, dd, slash: `${yyyy}/${mm}/${dd}`, short: `${mm}/${dd}` };
}

function rowHasToday(value) {
  const keys = todayKeys();
  const text = String(value || "");
  return text.includes(keys.slash) || text.includes(keys.short);
}

function summaryTpr(rows) {
  if (!rows.length) return "尚未擷取";
  const todayRows = rows.filter((row) => rowHasToday(row.time));
  const selected = todayRows.length ? todayRows : [rows[0]];
  return selected.map((row) => `${row.time || ""} T ${row.t || row.bt || "-"} P ${row.p || row.pr || row.hr || "-"} R ${row.r || row.rr || "-"}${row.bp ? ` BP ${row.bp}` : ""}${row.spo2 ? ` SpO2 ${row.spo2}` : ""}`).join("；");
}

function summaryLabs(rows) {
  if (!rows.length) return "尚未擷取";
  const todayRows = rows.filter((row) => rowHasToday(row.time));
  const selected = todayRows.length ? todayRows : rows.filter((row) => row.time === rows[0]?.time);
  const time = selected[0]?.time || "";
  const values = selected.slice(0, 12).map((row) => `${row.item || "Lab"} ${[row.latest, row.unit, row.flag].filter(Boolean).join(" ")}`).join("；");
  return `${time ? `${time} ` : ""}${values || "尚無數值"}`;
}

function summaryImaging(rows, options = {}) {
  if (!rows.length) return "尚未擷取";
  const todayRows = rows.filter((row) => rowHasToday(row.date));
  const row = todayRows[0] || rows[0];
  const result = row.impression || row.report || "";
  if (options.compact) return `${row.date || ""} ${row.type || "影像"}${result ? "：有報告，請展開查看" : ""}`;
  return `${row.date || ""} ${row.type || "影像"}${result ? `：${result}` : ""}`.slice(0, 220);
}

function summaryClinicalTables(patient) {
  const tprRows = selectSummaryTprRows(patientTprRows(patient));
  const labMatrix = selectSummaryLabMatrix(patient.labs || []);
  return `
    ${admissionStayBanner(patient)}
    <div class="summary-clinical-grid">
      <section>
        <h3>TPR</h3>
        ${tprRows.length ? table(
          ["日期", "時間", "T", "P", "R", "BP", "SpO2"],
          tprRows.map((row) => [tprDateLabel(row.time), tprTimeLabel(row.time), row.t || row.bt, row.p || row.pr || row.hr, row.r || row.rr, row.bp || [row.sbp, row.dbp].filter(Boolean).join("/"), row.spo2]),
          "summary-table"
        ) : missingDataState()}
      </section>
      <section>
        <h3>Labs：最近 3 次抽血</h3>
        ${labMatrix.columns.length ? table(
          ["項目", "參考值", ...labMatrix.columns],
          labMatrix.rows.map((row) => [row.item, row.ref || "", ...labMatrix.columns.map((column) => labCellHtml(row.values[column]))]),
          "summary-table"
        ) : missingDataState()}
      </section>
    </div>
    <section class="summary-io-section">
      <h3>I/O</h3>
      ${patient.intakeOutput ? ioSummary(patient.intakeOutput) : missingDataState()}
    </section>
    <div class="summary-report-grid">
      ${summaryExpandableList("影像 / 檢查", patient.imaging || [], imagingSummaryTitle, imagingSummaryBody)}
      ${summaryExpandableList("手術", patient.surgeries || [], surgerySummaryTitle, surgerySummaryBody)}
      ${summaryExpandableList("病理", patient.pathology || [], pathologySummaryTitle, pathologySummaryBody)}
    </div>
  `;
}

function selectSummaryTprRows(rows) {
  if (!rows.length) return [];
  const normalized = rows
    .map((row, index) => ({ row, index, key: tprDateKey(row.time), time: parseDisplayTime(row.time) }))
    .filter((item) => item.key);
  if (!normalized.length) return rows.slice(0, 12);
  const dateKeys = [...new Set(normalized
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map((item) => item.key))]
    .slice(0, 3);
  const selected = normalized
    .filter((item) => dateKeys.includes(item.key))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map((item) => item.row);
  return selected;
}

function tprDateKey(value) {
  const text = String(value || "");
  const full = text.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (full) return `${full[1]}/${full[2].padStart(2, "0")}/${full[3].padStart(2, "0")}`;
  const short = text.match(/(^|\D)(\d{1,2})[\/-](\d{1,2})(\D|$)/);
  if (short) return `${short[2].padStart(2, "0")}/${short[3].padStart(2, "0")}`;
  return "";
}

function tprDateLabel(value) {
  return tprDateKey(value) || "";
}

function tprTimeLabel(value) {
  const text = String(value || "");
  const time = text.match(/(\d{1,2}):(\d{2})/);
  return time ? `${time[1].padStart(2, "0")}:${time[2]}` : text;
}

function selectSummaryLabMatrix(rows) {
  const bloodRows = rows.filter((row) => normalizeLabGroup(row.group || row.kind || row.item) === "blood" && row.time);
  if (!bloodRows.length) return { columns: [], rows: [] };
  const priority = ["WBC", "HGB", "HCT", "Platelet", "Neutrophil", "Lymphocyte", "BUN", "Creatinine", "eGFR", "Na", "K", "CRP", "Albumin"];
  const columns = [...new Set(bloodRows.map((row) => row.time).filter(Boolean))].slice(0, 3);
  const items = [...new Set(bloodRows.map((row) => row.item).filter(Boolean))]
    .sort((a, b) => priorityIndex(a, priority) - priorityIndex(b, priority) || a.localeCompare(b, "zh-Hant"))
    .slice(0, 14);
  const matrixRows = items.map((item) => {
    const values = {};
    for (const column of columns) {
      const found = bloodRows.find((row) => row.item === item && row.time === column);
      values[column] = found ? {
        value: found.latest || "",
        unit: found.unit || "",
        flag: normalizeLabFlag(found),
        rawFlag: found.flag || "",
        ref: found.ref || "",
      } : null;
    }
    const sample = bloodRows.find((row) => row.item === item) || {};
    return { item, ref: sample.ref || "", values };
  });
  return { columns, rows: matrixRows };
}

function priorityIndex(item, priority) {
  const text = String(item || "").toLowerCase();
  const index = priority.findIndex((key) => text.includes(key.toLowerCase()));
  return index === -1 ? priority.length : index;
}

function summaryExpandableList(label, rows, titleFormatter, bodyFormatter) {
  if (!rows.length) return "";
  const row = rows[0];
  return `
    <details class="summary-imaging">
      <summary>${escapeHtml(label)}：${escapeHtml(titleFormatter(row))}</summary>
      <div class="summary-imaging-list">
        <article>
          <strong>${escapeHtml(titleFormatter(row))}</strong>
          <pre>${escapeHtml(bodyFormatter(row))}</pre>
        </article>
      </div>
    </details>
  `;
}

function imagingSummaryTitle(row) {
  return [row.source || "Image/Exam", row.date, row.type || "影像/檢查"].filter(Boolean).join(" · ");
}

function imagingSummaryBody(row) {
  return row.impression || row.report || "有標題，尚無報告文字";
}

function surgerySummaryTitle(row) {
  return [row.date, row.procedure || row.operation || "手術紀錄"].filter(Boolean).join(" · ");
}

function surgerySummaryBody(row) {
  const operativeProcedure = surgeryOperativeProcedure(row);
  const note = surgeryExtraNote(row, operativeProcedure);
  return [
    row.diagPre ? `術前診斷：${row.diagPre}` : "",
    row.diagPost ? `術後診斷：${row.diagPost}` : "",
    row.finding ? `Operative Findings：\n${row.finding}` : "",
    operativeProcedure ? `Operative Procedure：\n${operativeProcedure}` : "",
    note,
  ].filter(Boolean).join("\n") || "有手術標題，尚無詳細報告";
}

function pathologySummaryTitle(row) {
  return [row.source || "Patho", row.date, pathologyDisplayTitle(row)].filter(Boolean).join(" · ");
}

function pathologySummaryBody(row) {
  return [row.diagnosis ? `Diagnosis：${row.diagnosis}` : "", row.report || ""].filter(Boolean).join("\n") || "有病理標題，尚無詳細報告";
}

function admissionStayBanner(patient) {
  const label = admissionPeriodLabel(patient);
  if (!label) return "";
  return `
    <div class="admission-stay-banner">
      <strong>住院區間</strong>
      <span>${escapeHtml(label)}</span>
      ${patient.bedNo ? `<small>${escapeHtml(patient.bedNo)}</small>` : ""}
    </div>
  `;
}

function diagnosisLine(patient) {
  const first = patient.clinicalContext?.aiIntegrated?.explicitDiagnoses?.[0];
  return displayText(first) || displayText(patient.clinicalContext?.admissionReason?.text) || displayText(patient.clinicalContext?.admissionReason) || "尚未擷取";
}

function historyLine(patient) {
  const rows = patient.clinicalContext?.aiIntegrated?.importantHistory || patient.clinicalContext?.pastHistory || [];
  if (rows.length) return rows.map(displayText).filter(Boolean).join("；") || historyLoadStatus(patient);
  return historyLoadStatus(patient);
}

function historyLoadStatus(patient) {
  const loaded = new Set(patient.loadedSources || []);
  const results = new Map((patient.sourceResults || []).map((item) => [item.source, item]));
  const failed = ["adult_assessment", "nursing"].find((source) => results.get(source)?.status === "error");
  if (failed) return failed === "adult_assessment" ? "成人入院評估讀取失敗，請回原系統核對" : "護理入院評估讀取失敗，請回原系統核對";
  if (!loaded.has("adult_assessment") || !loaded.has("nursing")) return "正在讀取入院評估與護理病史…";
  const assessment = patient.clinicalContext?.adultAdmissionAssessment;
  if (assessment?.pastHistoryStatus === "reported_none") return "成人入院評估記載無過去病史";
  return "入院評估未提供過去病史";
}

function summarySurgery(rows) {
  if (!rows.length) return "尚未擷取";
  const row = rows[0];
  return `${row.date || ""} ${row.procedure || row.operation || row.note || "手術紀錄"}`;
}

function roundingChecklist(patient, coverage) {
  const missing = coverage.filter((item) => item.status !== "ok");
  const items = [
    patient.displayName && patient.displayName !== "待由 Onepage 識別" ? "已核對病人識別與床位" : "先核對病人姓名、病歷號與床位",
    patient.orders?.length ? "已開啟醫囑分頁，核對 active / DC / 給藥與處置時間" : "尚未取得醫囑，請回 Onepage / NIS 核對",
    patient.clinicalContext?.adultAdmissionAssessment ? "已查看入院原因、病史與功能／護理評估" : "尚未取得入院評估，請補看入院原因與過去病史",
    missing.some((item) => item.label === "TPR") ? "TPR 尚未接入；請以原始系統結果為準" : "已檢查 TPR 區塊與時間戳",
    missing.some((item) => item.label === "Labs") ? "Labs 尚未接入；請以原始系統結果為準" : "已檢查 Labs 區塊",
    missing.some((item) => item.label === "影像") ? "影像尚未接入；請以正式報告為準" : "已檢查影像報告",
    missing.some((item) => item.label === "手術") ? "手術紀錄尚未接入；請回原系統核對" : "已檢查手術紀錄",
    missing.some((item) => item.label === "病理") ? "病理報告尚未接入；請回 Onepage Patho 核對" : "已檢查病理報告",
    missing.some((item) => item.label === "護理") ? "護理紀錄尚未接入；請回原系統核對" : "已檢查護理紀錄",
  ];
  return `<ul class="rounding-checklist">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderLabs(patient) {
  const history = patient.labHistory;
  if (patient.labView === "all" && history) return `${renderLabHistoryControls(history)}${renderAllLabs(patient.labHistoryAll || [])}`;
  const matrix = history?.labMatrix || patient.labMatrix;
  const controls = history ? renderLabHistoryControls(history) : `<div class="lab-history-controls"><span>完整檢驗歷史可分頁查看</span><div class="actions"><button type="button" class="lab-history-load">載入完整歷史</button></div></div>`;
  if (matrix?.columns?.length && matrix?.rows?.length) {
    const groups = groupLabMatrixRows(matrix.rows);
    return `${controls}${Object.entries(groups).map(([group, rows]) => `
      <section class="lab-section">
        <h3>${escapeHtml(labGroupLabel(group))}</h3>
        ${table(
          ["項目", "參考值", ...matrix.columns],
          rows.map((row) => [row.item, row.ref || "", ...matrix.columns.map((column) => labCellHtml(row.values?.[column]))]),
          "lab-matrix-table"
        )}
      </section>
    `).join("")}`;
  }

  const groups = groupLabRows(patient.labs || []);
  return `${controls}${Object.entries(groups).map(([group, rows]) => `
    <section class="lab-section">
      <h3>${escapeHtml(labGroupLabel(group))}</h3>
      ${table(
        ["項目", "最新", "單位", "參考值", "趨勢", "前值"],
        rows.map((row) => [
          row.item,
          labValueHtml(row),
          row.unit || "",
          row.ref || "",
          row.trend ? `<span class="trend-${escapeHtml(row.trend)}">${escapeHtml(row.trend)}</span>` : "",
          row.previous,
        ]),
        "lab-list-table"
      )}
    </section>
  `).join("") || missingDataState()}`;
}

function renderLabHistoryControls(history) {
  if (!history.totalDates) return "";
  const start = history.offset + 1;
  const end = history.offset + (history.dates?.length || 0);
  const startOptions = (history.availableDates || []).map((date) => `<option value="${escapeHtml(date)}" ${date === history.startDate ? "selected" : ""}>${escapeHtml(date)}</option>`).join("");
  const endOptions = (history.availableDates || []).map((date) => `<option value="${escapeHtml(date)}" ${date === history.endDate ? "selected" : ""}>${escapeHtml(date)}</option>`).join("");
  return `<div class="lab-history-controls">
    <span>檢驗日期 ${start}-${end} / ${history.totalDates}</span>
    <label>起日<select class="lab-range-start">${startOptions}</select></label>
    <label>迄日<select class="lab-range-end">${endOptions}</select></label>
    <div class="actions">
      <button type="button" class="lab-range-apply">查詢</button>
      <button type="button" class="lab-history-all">顯示全部 Lab 數值</button>
      <button type="button" class="lab-history-page" data-lab-history-offset="${Math.max(0, history.offset - 3)}" ${history.hasNewer ? "" : "disabled"}>更新</button>
      <button type="button" class="lab-history-page" data-lab-history-offset="${history.offset + 3}" ${history.hasOlder ? "" : "disabled"}>更早</button>
    </div>
  </div>`;
}

function renderAllLabs(rows) {
  const sorted = [...rows].sort((a, b) => parseDisplayTime(b.time) - parseDisplayTime(a.time) || String(a.item || "").localeCompare(String(b.item || ""), "zh-Hant"));
  return `<section class="lab-section"><h3>全部 Lab 數值</h3>${searchableTable(
    ["日期時間", "項目", "數值", "單位", "參考值"],
    sorted.map((row) => [row.time || "", row.item || "", labValueHtml(row), row.unit || "", row.ref || ""]),
    "lab-all-table",
    "搜尋日期、項目或數值"
  )}</section>`;
}

function groupLabMatrixRows(rows = []) {
  return groupBy(rows, (row) => row.group || inferLabGroup(row.item));
}

function groupLabRows(rows = []) {
  return groupBy(rows, (row) => normalizeLabGroup(row.group || row.kind || row.item));
}

function groupBy(rows, getKey) {
  const order = ["blood", "urine", "other"];
  const grouped = { blood: [], urine: [], other: [] };
  for (const row of rows) {
    const key = normalizeLabGroup(getKey(row));
    grouped[key].push(row);
  }
  return Object.fromEntries(order.filter((key) => grouped[key].length).map((key) => [key, grouped[key]]));
}

function normalizeLabGroup(value) {
  const text = String(value || "").toLowerCase();
  if (/urine|u\/a|urinalysis|sediment|尿/.test(text)) return "urine";
  if (/blood|serum|plasma|cbc|wbc|rbc|hgb|hct|platelet|bun|creatinine|sodium|potassium|chloride|ast|alt|glucose|血/.test(text)) return "blood";
  return "other";
}

function inferLabGroup(item) {
  return normalizeLabGroup(item);
}

function labGroupLabel(group) {
  if (group === "blood") return "Blood Table";
  if (group === "urine") return "Urine Table";
  return "Other Labs";
}

function labValueHtml(row = {}) {
  const flag = normalizeLabFlag(row);
  const value = [labDisplayValue(row), row.rawFlag || row.flag || ""].filter(Boolean).join(" ");
  if (!value) return "";
  return `<span class="lab-value ${flag ? `lab-${escapeHtml(flag)}` : ""}">${escapeHtml(value)}</span>`;
}

function labCellHtml(cell) {
  if (!cell) return "";
  if (typeof cell === "object") {
    const flag = normalizeLabFlag(cell);
    const text = [labDisplayValue(cell), cell.unit, cell.rawFlag || cell.flag].filter(Boolean).join(" ");
    return text ? `<span class="lab-value ${flag ? `lab-${escapeHtml(flag)}` : ""}">${escapeHtml(text)}</span>` : "";
  }
  const parsed = parseLabTextFlag(cell);
  return parsed.text ? `<span class="lab-value ${parsed.flag ? `lab-${escapeHtml(parsed.flag)}` : ""}">${escapeHtml(parsed.text)}</span>` : "";
}

function labDisplayValue(row = {}) {
  return firstNonEmpty(row.value, row.latest, row.result, row.text, row.display, row.rawValue);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeLabFlag(row = {}) {
  const flag = String(row.flag || row.rawFlag || "").trim().toLowerCase();
  if (/^(h|hi|high|\+|↑|red)$/.test(flag) || /\bh\b|high|↑/.test(flag)) return "high";
  if (/^(l|lo|low|↓|blue)$/.test(flag) || /\bl\b|low|↓/.test(flag)) return "low";
  const numeric = Number.parseFloat(String(labDisplayValue(row)).replace(/,/g, ""));
  const ref = parseReferenceRange(row.ref || "");
  if (Number.isFinite(numeric) && ref) {
    if (ref.low !== null && numeric < ref.low) return "low";
    if (ref.high !== null && numeric > ref.high) return "high";
  }
  return "";
}

function parseLabTextFlag(text) {
  const value = String(text || "").trim();
  const flag = /\bH\b|high|↑/.test(value) ? "high" : /\bL\b|low|↓/.test(value) ? "low" : "";
  return { text: value, flag };
}

function parseReferenceRange(refText) {
  const text = String(refText || "").replace(/,/g, "").trim();
  const range = text.match(/(-?\d+(?:\.\d+)?)\s*[-~]\s*(-?\d+(?:\.\d+)?)/);
  if (range) return { low: Number(range[1]), high: Number(range[2]) };
  const lessThan = text.match(/[<≤]\s*(-?\d+(?:\.\d+)?)/);
  if (lessThan) return { low: null, high: Number(lessThan[1]) };
  const greaterThan = text.match(/[>≥]\s*(-?\d+(?:\.\d+)?)/);
  if (greaterThan) return { low: Number(greaterThan[1]), high: null };
  return null;
}

function renderOrders(orders) {
  const sorted = sortChronological(orders, (row) => firstDisplayLine(row.start || row.signedAt || row.givenAt || row.end));
  return searchableTable(
    ["開始", "結束", "出院醫囑", "DC", "醫囑內容", "簽收者", "簽收時間", "給藥者", "給藥時間"],
    sorted.map((row) => [row.start, row.end, row.dischargeOrder, row.dc, row.item, row.signer, row.signedAt, row.giver, row.givenAt]),
    "orders-table",
    "搜尋醫囑關鍵字"
  );
}

function renderSurgeries(surgeries) {
  if (!surgeries.length) return missingDataState();
  return `
    <div class="surgery-layout">
      <div class="surgery-list" aria-label="手術清單">
        ${surgeries.map((row, index) => `
          <a class="surgery-list-item" href="#surgery-${index}">
            <span>${escapeHtml(row.date || "")}</span>
            <strong>${escapeHtml(row.procedure || row.operation || "手術紀錄")}</strong>
          </a>
        `).join("")}
      </div>
      <div class="surgery-records">
        ${surgeries.map((row, index) => surgeryRecord(row, index)).join("")}
      </div>
    </div>
  `;
}

function renderImaging(imaging) {
  if (!imaging.length) return missingDataState();
  return `
    <div class="surgery-layout imaging-layout">
      <div class="surgery-list" aria-label="影像清單">
        ${imaging.map((row, index) => `
          <a class="surgery-list-item" href="#imaging-${index}">
            <span>${escapeHtml([row.source || "Image/Exam", row.date || ""].filter(Boolean).join(" · "))}</span>
            <strong>${escapeHtml(row.type || "影像報告")}</strong>
          </a>
        `).join("")}
      </div>
      <div class="surgery-records">
        ${imaging.map((row, index) => imagingRecord(row, index)).join("")}
      </div>
    </div>
  `;
}

function renderPathology(pathology) {
  if (!pathology.length) return missingDataState();
  return `
    <div class="surgery-layout pathology-layout">
      <div class="surgery-list" aria-label="病理清單">
        ${pathology.map((row, index) => `
          <a class="surgery-list-item" href="#pathology-${index}">
            <span>${escapeHtml([row.source || "Patho", row.date || ""].filter(Boolean).join(" · "))}</span>
            <strong>${escapeHtml(pathologyDisplayTitle(row))}</strong>
          </a>
        `).join("")}
      </div>
      <div class="surgery-records">
        ${pathology.map((row, index) => pathologyRecord(row, index)).join("")}
      </div>
    </div>
  `;
}

function imagingRecord(row, index) {
  const report = row.report || row.impression || "";
  return `
    <article id="imaging-${index}" class="surgery-record imaging-record">
      <div class="record-heading">
        <div>
          <p class="eyebrow">${escapeHtml(row.date || "")}</p>
          <h3>${escapeHtml([row.source || "Image/Exam", row.type || "影像報告"].filter(Boolean).join(" · "))}</h3>
        </div>
      </div>
      ${row.impression ? `<section class="record-block"><h4>Impression</h4><pre>${escapeHtml(row.impression)}</pre></section>` : ""}
      ${report && report !== row.impression ? `<section class="record-block"><h4>Report</h4><pre>${escapeHtml(report)}</pre></section>` : ""}
    </article>
  `;
}

function pathologyRecord(row, index) {
  const title = pathologyDisplayTitle(row);
  return `
    <article id="pathology-${index}" class="surgery-record pathology-record">
      <div class="record-heading">
        <div>
          <p class="eyebrow">${escapeHtml(row.date || "")}</p>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <span>${escapeHtml([row.source || "Patho", row.specimen || ""].filter(Boolean).join(" · "))}</span>
      </div>
      ${row.diagnosis ? `<section class="record-block"><h4>Diagnosis</h4><pre>${escapeHtml(row.diagnosis)}</pre></section>` : ""}
      ${row.report ? `<section class="record-block"><h4>Report</h4><pre>${escapeHtml(row.report)}</pre></section>` : ""}
      ${row.clinicalInfo && row.clinicalInfo !== row.report ? `<section class="record-block"><h4>Clinical Info</h4><pre>${escapeHtml(row.clinicalInfo)}</pre></section>` : ""}
    </article>
  `;
}

function pathologyDisplayTitle(row = {}) {
  const candidates = [
    row.title,
    row.diagnosis,
    row.specimen,
    row.type,
    row.report,
  ];
  for (const candidate of candidates) {
    const title = firstDisplayLine(candidate);
    if (title && !/^patho(?:logy)?$/i.test(title) && title !== "病理報告") return title;
  }
  return "病理報告";
}

function firstDisplayLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function surgeryRecord(row, index) {
  const operativeProcedure = surgeryOperativeProcedure(row);
  const note = surgeryExtraNote(row, operativeProcedure);
  const fields = [
    ["房號", row.room],
    ["流水序號", row.key],
    ["手術日期", row.date],
    ["開始", row.start],
    ["結束", row.end],
    ["科別", row.dept],
    ["術前診斷", row.diagPre],
    ["術後診斷", row.diagPost],
    ["手術適應症", row.indication],
    ["手術併發症", row.complication],
    ["失血量", row.bloodLoss],
    ["麻醉", row.anesthesia],
    ["抗生素", row.antibioticsUsed],
    ["手術名稱", row.procedure],
    ["手術方式", row.operation],
    ["主治醫師", row.surgeon],
    ["住院醫師", row.resident],
    ["刷手護士", row.scrubNurse],
    ["流動護士", row.circulatingNurse],
    ["手術碼", row.codes],
  ].filter(([, value]) => value);

  return `
    <article id="surgery-${index}" class="surgery-record">
      <div class="record-heading">
        <div>
          <p class="eyebrow">${escapeHtml(row.date || "")}</p>
          <h3>${escapeHtml(row.procedure || row.operation || "手術紀錄")}</h3>
        </div>
        <span>${escapeHtml(row.room || "")}</span>
      </div>
      <dl class="detail-grid">
        ${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
      </dl>
      ${row.finding ? `<section class="record-block surgery-report-block"><h4>Operative Findings</h4><pre>${escapeHtml(row.finding)}</pre></section>` : ""}
      ${operativeProcedure ? `<section class="record-block surgery-report-block"><h4>Operative Procedure</h4><pre>${escapeHtml(operativeProcedure)}</pre></section>` : ""}
      ${note ? `<section class="record-block"><h4>備註 / 紀錄</h4><pre>${escapeHtml(note)}</pre></section>` : ""}
    </article>
  `;
}

function surgeryOperativeProcedure(row = {}) {
  return row.operativeProcedure || "";
}

function surgeryExtraNote(row = {}, operativeProcedure = "") {
  const note = String(row.note || "").trim();
  if (!note) return "";
  const finding = String(row.finding || "").trim();
  if (note === finding || note === operativeProcedure) return "";
  if (finding && operativeProcedure && note.includes(finding) && note.includes(operativeProcedure)) return "";
  return note;
}

function renderNursing(nursing) {
  if (!nursing.length) return missingDataState();
  const sorted = [...nursing].sort((a, b) => parseDisplayTime(a.time) - parseDisplayTime(b.time));
  return searchableTable(
    ["時間", "類別", "內容", "輸入者"],
    sorted.map((row) => [row.time, row.type || "護理紀錄", row.note || "", row.author || ""]),
    "nursing-table",
    "搜尋護理紀錄關鍵字"
  );
}

function sortChronological(rows, timeGetter) {
  return [...rows].sort((a, b) => parseDisplayTime(timeGetter(a)) - parseDisplayTime(timeGetter(b)));
}

function renderTpr(tpr, io) {
  return table(
    ["時間", "T", "P", "R", "BP", "SpO2"],
    tpr.map((row) => [row.time, row.t || row.bt, row.p || row.pr || row.hr, row.r || row.rr, row.bp || [row.sbp, row.dbp].filter(Boolean).join("/"), row.spo2])
  ) + ioSummary(io);
}

function clinicalContext(context, sources = []) {
  if (!context) return `<div class="empty-state">尚未擷取診斷病史資料。</div>`;
  const integrated = context.aiIntegrated;
  if (integrated) return integratedDiagnosisContext(context, sources);
  return `
    <div class="context-actions">
      <button id="refreshContext" type="button">重新擷取診斷病史</button>
      <span>系統會由病歷號或床號自動解析目前住院資料；其他來源待接 parser。</span>
    </div>
    <div class="context-grid">
      <section><h3>目前診斷 / 住院問題</h3>${sourceList(context.currentDiagnoses)}</section>
      <section><h3>過去病史</h3>${sourceList(context.pastHistory)}</section>
      <section class="wide"><h3>住院原因摘要</h3>${context.admissionReason ? records([{ title: context.admissionReason.source, body: context.admissionReason.text }]) : `<div class="empty-state">尚未擷取。</div>`}</section>
      <section class="wide"><h3>成人入院評估單</h3>${adultAssessment(context.adultAdmissionAssessment)}</section>
      <section class="wide"><h3>病摘與 Progress</h3>${noteSessionRecords(context.noteSession)}</section>
      <section class="wide"><h3>來源擷取工作台</h3>${sourceWorkbench(context.sourceExtracts || [])}</section>
      <section class="wide"><h3>資料來源狀態</h3>${table(["來源", "狀態", "用途"], (sources || []).map((row) => [row.source, row.status, row.usage]))}</section>
    </div>
  `;
}

function notePanel(patient) {
  const notes = patient.clinicalContext?.noteSession || {};
  const progress = Array.isArray(notes.progress) ? notes.progress : [];
  const dates = progress.length ? `<select disabled>${progress.map((row) => `<option>${escapeHtml(row.date || "未提供日期")}</option>`).join("")}</select>` : `<div class="empty-state compact">目前沒有可選的 Progress 索引。</div>`;
  return `<section class="record-block"><h3>OneRecord Note</h3><p>入院病摘、Progress 與出院病摘索引已列於診斷病史來源。</p>${dates}<div class="empty-state">為避免把院內 OneRecord 登入權杖傳到院外，原始文件僅能在院內工作站的 Note 分頁檢視。</div></section>`;
}

function integratedDiagnosisContext(context, sources = []) {
  const integrated = context.aiIntegrated || {};
  return `
    <div class="context-actions">
      <button id="refreshContext" type="button">重新擷取診斷病史</button>
      <span>整合目前可取得來源；推測項目需回原始病歷核對。</span>
    </div>
    <div class="diagnosis-outline">
      <section class="diagnosis-section">
        <h3>正式 / 明確診斷</h3>
        ${diagnosisBulletList(integrated.explicitDiagnoses || [])}
      </section>
      <section class="diagnosis-section">
        <h3>過去病史</h3>
        ${diagnosisBulletList(integrated.importantHistory || [])}
      </section>
      <details class="diagnosis-detail">
        <summary>來源證據與擷取狀態</summary>
        <h3>來源證據</h3>
        ${evidenceTable(integrated.evidence || [])}
        <h3>Surgical postoperative diagnosis</h3>
        ${surgicalDiagnosisEvidence(context.surgicalDiagnosisEvidence || [])}
        <h3>成人入院評估單</h3>${adultAssessment(context.adultAdmissionAssessment)}
        <h3>護理入院評估</h3>${nursingAdmissionAssessment(context.nursingAdmissionAssessment)}
        <h3>病摘與 Progress</h3>${noteSessionRecords(context.noteSession)}
        <h3>來源擷取工作台</h3>${sourceWorkbench(context.sourceExtracts || [])}
        <h3>資料來源狀態</h3>${table(["來源", "狀態", "用途"], (sources || []).map((row) => [row.source, row.status, row.usage]))}
      </details>
    </div>
  `;
}

function nursingAdmissionAssessment(assessment) {
  if (!assessment) return `<div class="empty-state">尚未讀取護理入院評估。</div>`;
  const history = assessment.pastHistory
    ? `<article class="record-item"><strong>擷取的過去病史</strong><pre>${escapeHtml(assessment.pastHistory)}</pre></article>`
    : `<div class="empty-state compact">已讀取入院評估，但未找到可確認的過去病史。</div>`;
  return `
    <div class="assessment-grid">
      <article class="record-item"><strong>紀錄時間</strong><div>${escapeHtml(assessment.time || "")}</div></article>
      <article class="record-item"><strong>輸入者</strong><div>${escapeHtml(assessment.author || "")}</div></article>
    </div>
    ${history}
    <details class="diagnosis-detail">
      <summary>檢視首筆護理入院評估原文</summary>
      <pre>${escapeHtml(assessment.rawNote || "")}</pre>
    </details>
  `;
}

function noteSessionRecords(notes = {}) {
  const sections = [
    ["入院病摘", notes.admission ? [notes.admission] : []],
    ["Progress", Array.isArray(notes.progress) ? notes.progress : []],
    ["出院病摘", notes.discharge ? [notes.discharge] : []],
  ];
  return `<div class="record-list">${sections.map(([label, rows]) => `
    <details class="diagnosis-detail" ${label === "Progress" ? "open" : ""}>
      <summary>${escapeHtml(label)}${rows.length ? `（${rows.length} 筆）` : "（目前無資料）"}</summary>
      ${rows.length ? rows.map((row) => `<article class="record-item"><strong>${escapeHtml([row.date, row.title, row.author].filter(Boolean).join(" · ") || label)}</strong><pre>${escapeHtml(row.content || row.referenceText || "")}</pre></article>`).join("") : ""}
    </details>
  `).join("")}</div>`;
}

function diagnosisBulletList(items, options = {}) {
  if (!items.length) return `<div class="empty-state compact">尚無資料。</div>`;
  return `
    <ul class="diagnosis-bullets ${options.inferred ? "is-inferred" : ""}">
      ${items.map((item) => `
        <li>
          <strong>${escapeHtml(item.label || item.text || "")}</strong>
          <span>${escapeHtml([item.source, item.date, item.status === "推測" ? "推測" : ""].filter(Boolean).join(" · "))}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function surgicalDiagnosisEvidence(items = []) {
  if (!items.length) return `<div class="empty-state compact">No verified postoperative diagnosis extracted.</div>`;
  const effectLabel = {
    current_support: "Current admission: supports an existing diagnosis",
    past_history: "Previous admission: included as past history",
    review_only: "Unverified: surgery tab review only",
  };
  return records(items.map((item) => ({
    title: [item.date, item.diagnosis].filter(Boolean).join(" · ") || "Postoperative diagnosis",
    body: [
      item.procedure && `Procedure: ${item.procedure}`,
      effectLabel[item.effect] || "Unverified",
      item.admissionEvidence && `Episode evidence: ${item.admissionEvidence}`,
    ].filter(Boolean).join("; "),
  })));
}

function diagnosisItems(items) {
  if (!items.length) return `<div class="empty-state">尚無資料。</div>`;
  return `<div class="diagnosis-list">${items.map((item) => `
    <article class="diagnosis-item status-${item.status === "推測" ? "inferred" : "explicit"}">
      <div class="diagnosis-title">
        <strong>${escapeHtml(item.label || item.text || "")}</strong>
        <span>${escapeHtml(item.status || "明確")} · ${escapeHtml(item.confidence || "")}</span>
      </div>
      <p>${escapeHtml(item.text || "")}</p>
      <small>${escapeHtml(item.source || "")}${item.date ? ` · ${escapeHtml(item.date)}` : ""}</small>
    </article>
  `).join("")}</div>`;
}

function evidenceTable(evidence) {
  return table(
    ["類型", "內容", "來源", "日期", "信心"],
    evidence.map((item) => [item.kind, item.text, item.source, item.date, item.confidence])
  );
}

function adultAssessment(assessment) {
  if (!assessment) return `<div class="empty-state">尚未擷取成人入院評估單。</div>`;
  return `
    <div class="assessment-grid">
      <article class="record-item"><strong>入院原因</strong><div>${escapeHtml(assessment.admissionReason || "")}</div></article>
      <article class="record-item"><strong>過去病史</strong><div>${escapeHtml(assessment.pastHistory || "")}</div></article>
      <article class="record-item"><strong>功能 / 護理評估摘要</strong><div>${escapeHtml(assessment.functionalAssessment || "")}</div></article>
    </div>
    <p class="eyebrow">來源：${escapeHtml(assessment.source)} · 狀態：${escapeHtml(assessment.status)}</p>
  `;
}

function sourceWorkbench(sources) {
  if (!sources.length) return `<div class="empty-state">尚未設定資料來源。</div>`;
  return `
    <div class="source-grid">
      ${sources.map((source) => `
        <article class="source-card">
          <div><strong>${escapeHtml(source.source)}</strong><span>${escapeHtml(source.status)}</span></div>
          <p>${escapeHtml((source.fields || []).join("、"))}</p>
          <p class="source-result">${escapeHtml(source.lastResult || "")}</p>
          <button class="source-refresh" data-source="${escapeHtml(source.key)}" type="button">擷取此來源</button>
        </article>`).join("")}
    </div>
  `;
}

function sourceList(items = []) {
  if (!items.length) return `<div class="empty-state">尚無資料。</div>`;
  return records(items.map((item) => ({ title: item.source, body: item.text })));
}

function ioSummary(io) {
  if (!io) return "";
  if (Array.isArray(io.totals)) {
    const latestDate = sortIoColumns(io.columns || [])[0]?.date;
    const latest = io.totals.find((row) => row.date === latestDate) || io.totals.at(-1) || io.totals[0] || {};
    return `
      <div class="io-summary">
        <div><span>期間</span><strong>${escapeHtml(io.period || "尚未擷取")}</strong></div>
        <div><span>最近輸入總量</span><strong>${escapeHtml(latest.input || "")}</strong></div>
        <div><span>最近輸出總量</span><strong>${escapeHtml(latest.output || "")}</strong></div>
        <div><span>最近 Balance</span><strong>${escapeHtml(latest.balance || "")}</strong></div>
      </div>
    `;
  }
  return `
    <div class="io-summary">
      <div><span>期間</span><strong>${escapeHtml(io.period || "尚未擷取")}</strong></div>
      <div><span>輸入總量</span><strong>${escapeHtml(io.totals?.input || "")}</strong></div>
      <div><span>輸出總量</span><strong>${escapeHtml(io.totals?.output || "")}</strong></div>
      <div><span>Balance</span><strong>${escapeHtml(io.totals?.balance || "")}</strong></div>
    </div>
  `;
}

function ioPanel(io) {
  if (!io) return `<div class="empty-state">尚未擷取輸入輸出資料。</div>`;
  const columns = sortIoColumns(io.columns || []);
  if (columns.length) {
    return `
      ${ioSummary(io)}
      <div class="io-daily-list">
        ${columns.map((column) => ioDayCard(column, io)).join("")}
      </div>
    `;
  }
  return `
    ${ioSummary(io)}
    <div class="io-grid">
      <section><h3>輸入</h3>${table(["項目", "數值"], (io.input || []).map((row) => [row.item, row.value]))}</section>
      <section><h3>輸出</h3>${table(["項目", "數值"], (io.output || []).map((row) => [row.item, row.value]))}</section>
    </div>
  `;
}

function ioDayCard(column, io) {
  const total = (io.totals || []).find((row) => row.date === column.date) || {};
  const inputRows = ioDayRows("輸入", column.date, io.input || []);
  const outputRows = ioDayRows("輸出", column.date, io.output || []);
  const rows = [...inputRows, ...outputRows];
  return `
    <section class="io-day-card">
      <div class="io-day-heading">
        <h3>${escapeHtml(column.date)}</h3>
        <div>
          <span>入 ${escapeHtml(total.input || "-")}</span>
          <span>出 ${escapeHtml(total.output || "-")}</span>
          <strong>Balance ${escapeHtml(total.balance || "-")}</strong>
        </div>
      </div>
      ${rows.length ? table(["類別", "項目", "數值", "明細"], rows, "io-day-table") : `<div class="empty-state compact">此日無輸入輸出明細。</div>`}
    </section>
  `;
}

function ioDayRows(kind, date, records) {
  return records
    .map((record) => {
      const value = (record.values || []).find((item) => item.date === date);
      if (!value || (!value.value && !value.detail)) return null;
      return [
        kind,
        record.item || "",
        value.value || "",
        value.detail ? `<details class="io-detail"><summary>查看</summary><pre>${escapeHtml(value.detail)}</pre></details>` : "",
      ];
    })
    .filter(Boolean);
}

function renderGlucose(rows, result = null) {
  if (!rows.length) {
    const message = result?.status === "error"
      ? `血糖資料讀取失敗：${result.message || "院內來源暫時無法回應。"}`
      : result?.status === "ok"
        ? "已完成血糖資料查詢；此病人在目前院內系統提供的日期區間內沒有血糖／胰島素紀錄。"
        : "尚未載入血糖資料。請重新開啟此分頁後再試。";
    return missingDataState(message);
  }
  return table(
    ["血糖監測時間", "血糖值", "監測者", "注射時間", "藥物", "劑量", "施打部位", "Sliding Scale", "劑量", "注射者"],
    rows.map((row) => [
      row.glucoseTime || row.time,
      row.glucoseValue || row.value,
      row.monitor || "",
      row.injectionTime || "",
      row.medication || "",
      row.insulinDose || "",
      row.injectionSite || "",
      row.slidingScale || "",
      row.slidingDose || "",
      row.injector || "",
    ]),
    "glucose-table"
  );
}

function sourceResult(patient, source) {
  return (patient?.sourceResults || []).find((item) => item?.source === source) || null;
}

function ioWideTable(columns, records) {
  const sortedColumns = sortIoColumns(columns || []);
  return table(
    ["項目", ...sortedColumns.map((column) => column.date)],
    records.map((record) => [
      record.item,
      ...sortedColumns.map((column) => {
        const found = (record.values || []).find((value) => value.date === column.date);
        if (!found) return "";
        const detail = found.detail ? `\n${found.detail}` : "";
        return `${found.value || ""}${detail}`;
      }),
    ]),
    "io-wide-table"
  );
}

function sortIoColumns(columns = []) {
  return columns
    .map((column, index) => ({ column, index, time: ioDateSortValue(column.date) }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map((item) => item.column);
}

function ioDateSortValue(value) {
  const text = String(value || "").trim();
  const roc = text.match(/(?:民國\s*)?(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (roc) return Date.UTC(Number(roc[1]) + 1911, Number(roc[2]) - 1, Number(roc[3]));
  const gregorian = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (gregorian) return Date.UTC(Number(gregorian[1]), Number(gregorian[2]) - 1, Number(gregorian[3]));
  return parseDisplayTime(text);
}

function table(headers, rows = [], extraClass = "") {
  if (!rows.length) return missingDataState();
  return `
    <div class="table-wrap ${escapeHtml(extraClass)}">
      <table class="data-table">
        <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${isTrustedHtml(cell) ? cell : escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
  `;
}

function searchableTable(headers, rows = [], extraClass = "", placeholder = "搜尋關鍵字") {
  if (!rows.length) return missingDataState();
  return `
    <section class="chronology-panel" data-auto-latest="true">
      <div class="table-wrap chronology-scroll ${escapeHtml(extraClass)}">
        <table class="data-table searchable-table">
          <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody>
            ${rows.map((row) => {
              const searchText = row.map((cell) => String(cell ?? "")).join(" ");
              return `<tr data-search-text="${escapeHtml(searchText.toLowerCase())}">${row.map((cell) => `<td>${isTrustedHtml(cell) ? cell : escapeHtml(cell)}</td>`).join("")}</tr>`;
            }).join("")}
          </tbody>
        </table>
        <div class="empty-state compact no-search-results is-hidden">沒有符合關鍵字的紀錄。</div>
      </div>
      <div class="record-search-bar">
        <label>
          <span>關鍵字搜尋</span>
          <input class="record-search-input" type="search" placeholder="${escapeHtml(placeholder)}" autocomplete="off" />
        </label>
      </div>
    </section>
  `;
}

function isTrustedHtml(value) {
  const text = String(value ?? "");
  return text.startsWith("<span") || text.startsWith("<details");
}

function records(items) {
  if (!items.length) return missingDataState();
  return `<div class="record-list">${items.map((item) => `<article class="record-item"><strong>${escapeHtml(item.title)}</strong><div>${escapeHtml(item.body)}</div></article>`).join("")}</div>`;
}

function missingDataState(message = "尚未擷取資料。請輸入病歷號或床號查詢；若仍無資料，可能是院內工作站 session 已失效或此來源 parser 尚未接上。") {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function parseDisplayTime(value) {
  const time = new Date(String(value || "").replace(/\//g, "-")).getTime();
  return Number.isNaN(time) ? 0 : time;
}

async function loadPatient(query, options = {}) {
  if (!state.user) {
    el.loginMessage.textContent = "請先輸入 PIN，再查詢病人。";
    return;
  }
  const { updateRecent = true, silent = false } = options;
  if (!silent) {
    el.patientMeta.textContent = "正在查詢，若最近已擷取會直接使用快取...";
    el.refreshPatient.disabled = true;
  }
  const patient = await api("/api/patients/search", { method: "POST", body: JSON.stringify({ query, mode: "quick" }) });
  renderPatient(patient);
  if (!silent) {
    el.patientMeta.textContent = "基本資料已顯示，詳細資料正在背景載入…";
    void loadShadowPatientDetails(query, patientKey(patient));
  }
  if (updateRecent) loadRecent().catch(() => null);
  return patient;
}

async function loadShadowPatientDetails(query, expectedKey, sources = ["orders", "admission", "progress", "discharge", "adult_assessment", "imaging", "surgeries", "pathology", "nursing"]) {
  const loadKey = `${expectedKey}:${[...sources].sort().join(",")}`;
  if (state.detailLoadingKey === loadKey) return;
  state.detailLoadingKey = loadKey;
  try {
    const patient = await requestShadowPatient(query, { mode: "details", sources });
    if (patientKey(state.currentPatient) !== expectedKey) return;
    mergePatientLoad(patient, state.currentPatient);
    renderPatient(patient);
    switchTab(state.currentTab);
    el.patientMeta.textContent = patient.cacheStatus === "relay_cache" ? "詳細資料已由短期快取載入" : "詳細資料已更新";
  } catch {
    if (patientKey(state.currentPatient) === expectedKey) el.patientMeta.textContent = "基本資料已顯示；詳細資料暫時無法更新";
  } finally {
    if (state.detailLoadingKey === loadKey) state.detailLoadingKey = "";
  }
}

function mergePatientLoad(patient, previous = {}) {
  const collections = ["labs", "orders", "imaging", "surgeries", "pathology", "nursing", "glucose", "tpr", "vitals", "itpr"];
  for (const key of collections) {
    if ((!Array.isArray(patient[key]) || !patient[key].length) && Array.isArray(previous[key]) && previous[key].length) patient[key] = previous[key];
  }
  if (!patient.intakeOutput?.input?.length && previous.intakeOutput) patient.intakeOutput = previous.intakeOutput;
  patient.labMatrix ||= previous.labMatrix;
  patient.labHistory ||= previous.labHistory;
  patient.clinicalContext = { ...previous.clinicalContext, ...patient.clinicalContext };
  patient.loadedSources = [...new Set([...(previous.loadedSources || []), ...(patient.loadedSources || [])])];
  patient.sourceResults = [...(patient.sourceResults || []), ...(previous.sourceResults || [])]
    .filter((item, index, rows) => rows.findIndex((row) => row.source === item.source) === index);
}

async function openPhysicianRosterPatients() {
  const items = state.physicianRoster || [];
  if (!state.user || !items.length) return;
  el.openRosterPatients.disabled = true;
  el.refreshRosterPatients.disabled = true;
  el.physicianRosterForm.querySelector("button").disabled = true;
  let opened = 0;
  try {
    for (const [index, item] of items.entries()) {
      const query = item.chartNo || item.bedNo || item.feeNo;
      if (!query) continue;
      el.physicianRosterStatus.textContent = `正在開啟 ${index + 1}/${items.length}：${item.name || item.chartNo || query}`;
      await loadPatient(query, { updateRecent: false, silent: true });
      opened += 1;
    }
    el.physicianRosterStatus.textContent = `${state.physicianRosterDoctor?.id || ""}${state.physicianRosterDoctor?.name ? ` ${state.physicianRosterDoctor.name}` : ""}：已開啟 ${opened} 位病人`;
    await loadRecent().catch(() => null);
  } catch (error) {
    el.physicianRosterStatus.textContent = `開啟病人清單中斷：${error.message || "查詢失敗"}`;
  } finally {
    el.openRosterPatients.disabled = !state.user || !state.physicianRoster.length;
    el.refreshRosterPatients.disabled = !state.user || !state.physicianRoster.length;
    el.physicianRosterForm.querySelector("button").disabled = !state.user;
  }
}

async function refreshPhysicianRosterSummaries() {
  const items = state.physicianRoster || [];
  if (!state.user || !items.length) return;
  const previousCurrentKey = patientKey(state.currentPatient);
  el.openRosterPatients.disabled = true;
  el.refreshRosterPatients.disabled = true;
  el.physicianRosterForm.querySelector("button").disabled = true;
  let refreshed = 0;
  try {
    for (const [index, item] of items.entries()) {
      const query = item.chartNo || item.bedNo || item.feeNo;
      if (!query) continue;
      el.physicianRosterStatus.textContent = `正在更新 ${index + 1}/${items.length}：${item.name || item.chartNo || query}`;
      const patient = await api("/api/patients/refresh", {
        method: "POST",
        body: JSON.stringify({ patientRef: query }),
      });
      renderPatient(patient);
      refreshed += 1;
    }
    const doctor = state.physicianRosterDoctor || {};
    const doctorText = `${doctor.id || ""}${doctor.name ? ` ${doctor.name}` : ""}`.trim() || "醫師清單";
    el.physicianRosterStatus.textContent = `${doctorText}：已更新 ${refreshed} 位病人摘要`;
    const previousPatient = state.openPatients.find((patient) => patientKey(patient) === previousCurrentKey);
    if (previousPatient) {
      renderPatient(previousPatient, { store: false });
      switchTab(state.currentTab);
    }
    await loadRecent().catch(() => null);
  } catch (error) {
    el.physicianRosterStatus.textContent = `更新全部摘要中斷：${error.message || "查詢失敗"}`;
  } finally {
    el.openRosterPatients.disabled = !state.user || !state.physicianRoster.length;
    el.refreshRosterPatients.disabled = !state.user || !state.physicianRoster.length;
    el.physicianRosterForm.querySelector("button").disabled = !state.user;
  }
}

async function refreshPatient() {
  if (!state.currentPatient) return;
  el.patientMeta.textContent = "正在重新整理來源資料...";
  el.refreshPatient.disabled = true;
  const patient = await api("/api/patients/refresh", {
    method: "POST",
    body: JSON.stringify({ patientRef: state.currentPatient.patientRef || state.currentPatient.chartNo }),
  });
  renderPatient(patient);
  switchTab(state.currentTab);
}

async function loadRecent() {
  if (!state.user) {
    renderRecent([]);
    return;
  }
  const data = await api("/api/patients/recent");
  renderRecent(data.patients || []);
}

async function loadPhysicianRoster(query) {
  if (!state.user) {
    el.loginMessage.textContent = "請先輸入 PIN，再查詢醫師住院清單。";
    return;
  }
  const rawQuery = String(query || "").trim();
  const doctorId = rawQuery.match(/\d{3,}/)?.[0] || rawQuery;
  const typedName = rawQuery
    .replace(doctorId, "")
    .replace(/[()[\]#／/\\:：,，;；|醫師住院員工編號GSMgsm]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!doctorId) return;
  el.physicianRosterStatus.textContent = "正在讀取醫師住院清單...";
  el.physicianRosterForm.querySelector("button").disabled = true;
  try {
    const data = await api("/api/physicians/inpatients", {
      method: "POST",
      body: JSON.stringify({ doctorId }),
    });
    const physician = { ...(data.physician || { id: doctorId }), id: data.physician?.id || doctorId };
    if (!physician.name && typedName) physician.name = typedName;
    renderPhysicianRoster(data.patients || [], physician);
  } catch (error) {
    renderPhysicianRoster([], { id: doctorId, name: typedName }, `${error.message || "查詢失敗"}；若輸入姓名/GSM 無法解析，請改輸入醫師員工編號。`);
  } finally {
    el.physicianRosterForm.querySelector("button").disabled = !state.user;
  }
}

function switchTab(name) {
  state.currentTab = name;
  for (const tab of el.tabs) tab.classList.toggle("is-active", tab.dataset.tab === name);
  for (const panel of el.panels) panel.classList.toggle("is-hidden", panel.dataset.panel !== name);
  const tabSources = { imaging: ["imaging"], surgery: ["surgeries"], pathology: ["pathology"], io: ["intakeOutput"], nursing: ["nursing"], glucose: ["glucose"] };
  const sources = tabSources[name] || [];
  if (sources.length && state.currentPatient && !sources.every((source) => state.currentPatient.loadedSources?.includes(source))) {
    const query = state.currentPatient.patientRef || state.currentPatient.chartNo;
    el.patientMeta.textContent = `正在載入${name}資料…`;
    void loadShadowPatientDetails(query, patientKey(state.currentPatient), sources);
  }
  if (name === "labs" && state.currentPatient && !state.currentPatient.labHistory && !state.labHistoryLoading) {
    loadShadowLabHistory(0).catch((error) => { el.serviceStatus.textContent = error.message || "無法載入完整檢驗歷史"; });
  }
  if (name === "orders" || name === "nursing") requestAnimationFrame(() => scrollPanelToLatest(name));
}

function scrollPanelToLatest(name) {
  const panel = el.panels.find((item) => item.dataset.panel === name);
  const scrollBox = panel?.querySelector(".chronology-scroll");
  if (scrollBox) scrollBox.scrollTop = scrollBox.scrollHeight;
}

function filterChronologyPanel(input) {
  const panel = input.closest(".chronology-panel");
  if (!panel) return;
  const query = input.value.trim().toLowerCase();
  const rows = [...panel.querySelectorAll("tbody tr[data-search-text]")];
  let visible = 0;
  for (const row of rows) {
    const matched = !query || row.dataset.searchText.includes(query);
    row.classList.toggle("is-hidden", !matched);
    if (matched) visible += 1;
  }
  panel.querySelector(".no-search-results")?.classList.toggle("is-hidden", visible !== 0);
}

document.addEventListener("input", (event) => {
  if (event.target?.classList?.contains("record-search-input")) filterChronologyPanel(event.target);
});

document.addEventListener("click", async (event) => {
  if (event.target?.dataset?.togglePatientWindows !== undefined) {
    state.patientSwitcherExpanded = !state.patientSwitcherExpanded;
    renderPatientWindows();
    return;
  }
  if (event.target?.classList?.contains("lab-history-load")) {
    await loadShadowLabHistory(0).catch((error) => { el.serviceStatus.textContent = error.message || "無法載入完整檢驗歷史"; });
    return;
  }
  if (event.target?.classList?.contains("lab-range-apply")) {
    const startDate = document.querySelector(".lab-range-start")?.value || "";
    const endDate = document.querySelector(".lab-range-end")?.value || "";
    await loadShadowLabHistory(0, { startDate, endDate }).catch((error) => { el.serviceStatus.textContent = error.message || "無法載入指定檢驗範圍"; });
    return;
  }
  if (event.target?.classList?.contains("lab-history-all")) {
    await loadShadowAllLabs().catch((error) => { el.serviceStatus.textContent = error.message || "無法載入全部 Lab 數值"; });
    return;
  }
  const labHistoryOffset = event.target?.dataset?.labHistoryOffset;
  if (labHistoryOffset !== undefined) {
    const history = state.currentPatient?.labHistory || {};
    await loadShadowLabHistory(Number(labHistoryOffset), history).catch((error) => { el.serviceStatus.textContent = error.message || "無法載入完整檢驗歷史"; });
    return;
  }
  const switchKey = event.target?.dataset?.patientKey;
  if (switchKey && event.target.classList.contains("patient-window-switch")) {
    const patient = state.openPatients.find((item) => patientKey(item) === switchKey);
    if (patient) {
      renderPatient(patient, { store: false });
      switchTab(state.currentTab);
    }
    return;
  }

  const closeKey = event.target?.dataset?.closePatient;
  if (closeKey) {
    const closingCurrent = patientKey(state.currentPatient) === closeKey;
    state.openPatients = state.openPatients.filter((item) => patientKey(item) !== closeKey);
    if (closingCurrent) {
      const next = state.openPatients[0];
      if (next) {
        renderPatient(next, { store: false });
        switchTab(state.currentTab);
      } else {
        clearPatientView("尚未選擇病人。");
      }
    } else {
      renderPatientWindows();
    }
    return;
  }

  if (event.target?.id === "refreshContext") {
    if (!state.currentPatient) return;
    event.target.disabled = true;
    event.target.textContent = "擷取中";
    const patient = await api("/api/patients/refresh", {
      method: "POST",
      body: JSON.stringify({ patientRef: state.currentPatient.patientRef || state.currentPatient.chartNo }),
    });
    renderPatient(patient);
    switchTab(state.currentTab);
    event.target.disabled = false;
    event.target.textContent = "重新擷取診斷病史";
  }

  if (event.target?.classList?.contains("source-refresh")) {
    if (!state.currentPatient) return;
    event.target.disabled = true;
    event.target.textContent = "擷取中";
    const patient = await api("/api/patients/refresh", {
      method: "POST",
      body: JSON.stringify({ patientRef: state.currentPatient.patientRef || state.currentPatient.chartNo }),
    });
    renderPatient(patient);
    switchTab(state.currentTab);
    event.target.disabled = false;
    event.target.textContent = "擷取此來源";
  }

});

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = el.loginUser.value.trim();
  const password = el.loginPassword.value;
  el.loginMessage.textContent = "正在解鎖影子工作站...";
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    state.user = data.user;
    el.loginPassword.value = "";
    el.loginMessage.textContent = "";
    renderAuth();
    await loadRecent();
  } catch (error) {
    el.loginMessage.textContent = error.message || "PIN 驗證失敗，請確認影子工作站設定。";
  }
});

el.logoutButton.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => null);
  state.user = null;
  state.openPatients = [];
  clearPatientView("請先輸入影子工作站 PIN。");
  renderAuth();
  renderRecent([]);
  renderPhysicianRoster([]);
});

el.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = el.patientQuery.value.trim();
  if (query) loadPatient(query);
});

el.physicianRosterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadPhysicianRoster(el.physicianQuery.value);
});

el.reloadRecent.addEventListener("click", async () => {
  const originalText = el.reloadRecent.textContent;
  el.reloadRecent.disabled = true;
  el.reloadRecent.textContent = "…";
  try {
    await loadRecent();
    el.serviceStatus.textContent = "最近擷取已更新";
  } catch {
    el.recentList.innerHTML = `<div class="empty-state compact">讀取失敗，請確認 PIN 或 relay 狀態。</div>`;
    updateRecentStatus("清單讀取失敗，請確認 PIN 或 relay 狀態。");
  } finally {
    el.reloadRecent.textContent = originalText || "↻";
    el.reloadRecent.disabled = !state.user;
  }
});
el.openRosterPatients.addEventListener("click", openPhysicianRosterPatients);
el.refreshRosterPatients.addEventListener("click", refreshPhysicianRosterSummaries);
el.refreshPatient.addEventListener("click", refreshPatient);
el.refreshOnepage.addEventListener("click", () => refreshShadowOnepageSession().catch(() => null));
el.disableShadowRelay.addEventListener("click", () => disableShadowRelay().catch((error) => { el.serviceStatus.textContent = error.message || "無法停止影子連線"; }));
document.addEventListener("click", async (event) => {
  if (event.target?.id !== "copyStructuredSummary" || !state.currentPatient) return;
  const note = buildStructuredRoundingNote(state.currentPatient, buildCoverage(state.currentPatient));
  await copyText(note);
  event.target.textContent = "已複製";
  window.setTimeout(() => { event.target.textContent = "複製查房格式"; }, 1200);
});

el.copySummary.addEventListener("click", async () => {
  if (!state.currentPatient) return;
  await copyText(buildStructuredRoundingNote(state.currentPatient, buildCoverage(state.currentPatient)));
  el.copySummary.textContent = "已複製";
  window.setTimeout(() => {
    el.copySummary.textContent = "複製摘要";
  }, 1200);
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to textarea copy for LAN HTTP/mobile browsers.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

for (const tab of el.tabs) {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
}

api("/api/health")
  .then((data) => {
    el.serviceStatus.textContent = data.ok ? "服務已啟動" : "服務異常";
  })
  .catch(() => {
    el.serviceStatus.textContent = "服務未連線";
  });

refreshAuth().then(loadRecent).catch(() => {
  renderAuth();
  el.recentList.innerHTML = `<div class="empty-state compact">讀取失敗。</div>`;
});
