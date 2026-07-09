const state = {
  pin: localStorage.getItem("shadowPin") || "",
  patients: [],
  currentKey: "",
  currentTab: "summary",
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
  dataTabs: document.querySelector("#dataTabs"),
  patientTitle: document.querySelector("#patientTitle"),
  patientMeta: document.querySelector("#patientMeta"),
  refreshPatient: document.querySelector("#refreshPatient"),
  resultPanel: document.querySelector("#resultPanel"),
};

el.pin.value = state.pin;
setStatus(state.pin ? "PIN 已儲存" : "等待 PIN");

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
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
    renderSummaryResult(result);
    setStatus("病人資料已更新");
  } catch (error) {
    renderError(error);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  el.loadWard.disabled = busy;
  el.loadSummary.disabled = busy;
  el.refreshPatient.disabled = busy || !currentEntry();
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
    result: null,
  })).filter((item) => item.key);
  renderRoster();
  renderPatientTabs();
}

function renderRoster() {
  if (!state.patients.length) {
    el.roster.innerHTML = `<div class="empty">尚無病人清單。</div>`;
    return;
  }
  el.roster.innerHTML = state.patients.map(({ key, patient }) => `
    <button class="patient-item" type="button" data-query="${escapeHtml(key)}">
      <strong>${escapeHtml(patient.name || patient.displayName || patient.chartNo || key)} · ${escapeHtml(patient.bedNo || "床號待讀取")}</strong>
      <span>${escapeHtml([patient.chartNo, patient.dept, patient.admitDate ? `入院 ${shortDateLabel(patient.admitDate)}` : ""].filter(Boolean).join(" · "))}</span>
    </button>
  `).join("");
}

function renderSummaryResult(result) {
  const patient = result.patient || {};
  const key = patient.chartNo || patient.patientRef || patient.bedNo || result.query || "";
  if (key) {
    const existing = state.patients.find((item) => item.key === key);
    if (existing) {
      existing.patient = { ...existing.patient, ...patient };
      existing.result = result;
    } else {
      state.patients.unshift({ key, patient, result });
    }
    state.currentKey = key;
  }
  renderRoster();
  renderPatientTabs();
  renderCurrentPatient();
}

function currentEntry() {
  return state.patients.find((item) => item.key === state.currentKey) || null;
}

function currentPatient() {
  return currentEntry()?.result?.patient || currentEntry()?.patient || null;
}

function renderCurrentPatient() {
  const entry = currentEntry();
  const patient = currentPatient();
  if (!entry || !patient) return;
  const title = `${patient.chartNo || patient.patientRef || entry.key} ${patient.displayName || patient.name || ""}`;
  el.patientTitle.textContent = title.trim();
  el.patientMeta.textContent = [
    patient.bedNo ? `床 ${patient.bedNo}` : "",
    admissionPeriodLabel(patient),
    patient.updatedAt ? `${new Date(patient.updatedAt).toLocaleString("zh-TW", { hour12: false })} 更新` : "",
  ].filter(Boolean).join(" · ") || "資料待讀取";
  el.refreshPatient.disabled = false;
  renderDataTabs();
  renderPanel();
}

function renderPatientTabs() {
  el.patientTabs.innerHTML = state.patients.map((item) => `
    <button class="patient-tab ${item.key === state.currentKey ? "is-active" : ""}" type="button" data-tab-key="${escapeHtml(item.key)}">
      ${escapeHtml(item.patient?.name || item.patient?.displayName || item.patient?.chartNo || item.key)}
    </button>
  `).join("");
}

function renderDataTabs() {
  for (const tab of el.dataTabs.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.tab === state.currentTab);
  }
}

function renderPanel() {
  const entry = currentEntry();
  const patient = currentPatient();
  if (!entry || !patient) {
    el.resultPanel.innerHTML = `<div class="empty">尚未選擇病人。</div>`;
    return;
  }
  if (!entry.result && state.currentTab !== "summary") {
    el.resultPanel.innerHTML = `<div class="empty">此病人尚未載入完整資料，正在查詢...</div>`;
    loadSummary(entry.key);
    return;
  }

  const result = entry.result || {};
  const renderers = {
    summary: () => renderSummaryPanel(result),
    tpr: () => renderTpr(patient.tpr || patient.vitals || patient.itpr || [], patient.intakeOutput),
    labs: () => renderLabs(patient),
    io: () => ioPanel(patient.intakeOutput),
    imaging: () => renderImaging(patient.imaging || []),
    surgery: () => renderSurgeries(patient.surgeries || []),
    pathology: () => renderPathology(patient.pathology || []),
    orders: () => renderOrders(patient.orders || []),
    nursing: () => renderNursing(patient.nursing || []),
    glucose: () => renderGlucose(patient.glucose || []),
    ai: () => aiAssessment(patient.aiAssessment),
  };
  el.resultPanel.innerHTML = renderers[state.currentTab]?.() || missingDataState();
}

function renderSummaryPanel(result) {
  const patient = result.patient || currentPatient() || {};
  return `
    <div class="result-header">
      <div>
        <h2>${escapeHtml(patient.chartNo || patient.patientRef || "病人摘要")} ${escapeHtml(patient.displayName || patient.name || "")}</h2>
        <p class="muted">${escapeHtml([patient.bedNo ? `床 ${patient.bedNo}` : "", admissionPeriodLabel(patient)].filter(Boolean).join(" · "))}</p>
      </div>
      <span class="badge">摘要</span>
    </div>
    ${admissionStayBanner(patient)}
    <pre class="summary-text">${escapeHtml(result.text || "尚無摘要文字。")}</pre>
  `;
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

function admissionPeriodLabel(patient = {}) {
  const period = patient.admissionPeriod || {};
  const start = shortDateLabel(period.startDate || patient.admitDate);
  const end = shortDateLabel(period.endDate || patient.dischargeDate);
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
  return text.split(/[T\s]/)[0];
}

function admissionStayBanner(patient) {
  const label = admissionPeriodLabel(patient);
  if (!label) return "";
  return `
    <div class="admission-stay-banner">
      <strong>住院區間</strong>
      <span>${escapeHtml(label)}</span>
      ${patient.bedNo ? `<small>床 ${escapeHtml(patient.bedNo)}</small>` : ""}
    </div>
  `;
}

function renderLabs(patient) {
  const matrix = patient.labMatrix;
  if (matrix?.columns?.length && matrix?.rows?.length) {
    const groups = groupLabMatrixRows(matrix.rows);
    return Object.entries(groups).map(([group, rows]) => `
      <section class="lab-section">
        <h3>${escapeHtml(labGroupLabel(group))}</h3>
        ${table(
          ["項目", "參考值", ...matrix.columns],
          rows.map((row) => [row.item, row.ref || "", ...matrix.columns.map((column) => labCellHtml(row.values?.[column]))]),
          "lab-matrix-table"
        )}
      </section>
    `).join("");
  }

  const groups = groupLabRows(patient.labs || []);
  return Object.entries(groups).map(([group, rows]) => `
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
  `).join("") || missingDataState();
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
  const value = [row.latest ?? row.value ?? "", row.rawFlag || row.flag || ""].filter(Boolean).join(" ");
  if (!value) return "";
  return `<span class="lab-value ${flag ? `lab-${escapeHtml(flag)}` : ""}">${escapeHtml(value)}</span>`;
}

function labCellHtml(cell) {
  if (!cell) return "";
  if (typeof cell === "object") {
    const flag = normalizeLabFlag(cell);
    const text = [cell.value, cell.unit, cell.rawFlag].filter(Boolean).join(" ");
    return text ? `<span class="lab-value ${flag ? `lab-${escapeHtml(flag)}` : ""}">${escapeHtml(text)}</span>` : "";
  }
  const parsed = parseLabTextFlag(cell);
  return parsed.text ? `<span class="lab-value ${parsed.flag ? `lab-${escapeHtml(parsed.flag)}` : ""}">${escapeHtml(parsed.text)}</span>` : "";
}

function normalizeLabFlag(row = {}) {
  const flag = String(row.flag || row.rawFlag || "").trim().toLowerCase();
  if (/^(h|hi|high|\+|↑|red)$/.test(flag) || /\bh\b|high|↑/.test(flag)) return "high";
  if (/^(l|lo|low|↓|blue)$/.test(flag) || /\bl\b|low|↓/.test(flag)) return "low";
  const numeric = Number.parseFloat(String(row.latest ?? row.value ?? "").replace(/,/g, ""));
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

function renderTpr(tpr, io) {
  return table(
    ["時間", "T", "P", "R", "BP", "SpO2"],
    tpr.map((row) => [row.time, row.t || row.bt, row.p || row.pr || row.hr, row.r || row.rr, row.bp || [row.sbp, row.dbp].filter(Boolean).join("/"), row.spo2])
  ) + ioSummary(io);
}

function ioSummary(io) {
  if (!io) return "";
  if (Array.isArray(io.totals)) {
    const latest = io.totals.at(-1) || io.totals[0] || {};
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
  if (!io) return `<div class="empty">尚未擷取輸入輸出資料。</div>`;
  const columns = io.columns || [];
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
      ${rows.length ? table(["類別", "項目", "數值", "明細"], rows, "io-day-table") : `<div class="empty compact">此日無輸入輸出明細。</div>`}
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

function renderImaging(imaging) {
  if (!imaging.length) return missingDataState();
  return reportLayout("影像清單", imaging, "imaging", (row) => [row.source || "Image/Exam", row.date || ""].filter(Boolean).join(" · "), (row) => row.type || "影像報告", imagingRecord);
}

function renderSurgeries(surgeries) {
  if (!surgeries.length) return missingDataState();
  return reportLayout("手術清單", surgeries, "surgery", (row) => row.date || "", (row) => row.procedure || row.operation || "手術紀錄", surgeryRecord);
}

function renderPathology(pathology) {
  if (!pathology.length) return missingDataState();
  return reportLayout("病理清單", pathology, "pathology", (row) => [row.source || "Patho", row.date || ""].filter(Boolean).join(" · "), (row) => row.type || row.specimen || "病理報告", pathologyRecord);
}

function reportLayout(label, rows, prefix, metaFormatter, titleFormatter, recordFormatter) {
  return `
    <div class="report-layout">
      <div class="report-list" aria-label="${escapeHtml(label)}">
        ${rows.map((row, index) => `
          <a class="report-list-item" href="#${prefix}-${index}">
            <span>${escapeHtml(metaFormatter(row))}</span>
            <strong>${escapeHtml(titleFormatter(row))}</strong>
          </a>
        `).join("")}
      </div>
      <div class="report-records">
        ${rows.map((row, index) => recordFormatter(row, index)).join("")}
      </div>
    </div>
  `;
}

function imagingRecord(row, index) {
  const report = row.report || row.impression || "";
  return `
    <article id="imaging-${index}" class="report-record">
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
  return `
    <article id="pathology-${index}" class="report-record">
      <div class="record-heading">
        <div>
          <p class="eyebrow">${escapeHtml(row.date || "")}</p>
          <h3>${escapeHtml([row.source || "Patho", row.type || row.specimen || "病理報告"].filter(Boolean).join(" · "))}</h3>
        </div>
        <span>${escapeHtml(row.specimen || "")}</span>
      </div>
      ${row.diagnosis ? `<section class="record-block"><h4>Diagnosis</h4><pre>${escapeHtml(row.diagnosis)}</pre></section>` : ""}
      ${row.report ? `<section class="record-block"><h4>Report</h4><pre>${escapeHtml(row.report)}</pre></section>` : ""}
      ${row.clinicalInfo && row.clinicalInfo !== row.report ? `<section class="record-block"><h4>Clinical Info</h4><pre>${escapeHtml(row.clinicalInfo)}</pre></section>` : ""}
    </article>
  `;
}

function surgeryRecord(row, index) {
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
    <article id="surgery-${index}" class="report-record">
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
      ${row.finding ? `<section class="record-block"><h4>Operative Findings</h4><pre>${escapeHtml(row.finding)}</pre></section>` : ""}
      ${row.note && row.note !== row.finding ? `<section class="record-block"><h4>備註 / 紀錄</h4><pre>${escapeHtml(row.note)}</pre></section>` : ""}
    </article>
  `;
}

function renderOrders(orders) {
  return table(
    ["開始", "結束", "出院醫囑", "DC", "醫囑內容", "簽收者", "簽收時間", "給藥者", "給藥時間"],
    orders.map((row) => [row.start, row.end, row.dischargeOrder, row.dc, row.item, row.signer, row.signedAt, row.giver, row.givenAt]),
    "orders-table"
  );
}

function renderNursing(nursing) {
  if (!nursing.length) return missingDataState();
  const sorted = [...nursing].sort((a, b) => parseDisplayTime(a.time) - parseDisplayTime(b.time));
  return table(
    ["時間", "類別", "內容", "輸入者"],
    sorted.map((row) => [row.time, row.type || "護理紀錄", row.note || "", row.author || ""]),
    "nursing-table"
  );
}

function renderGlucose(rows) {
  return table(
    ["時間", "血糖", "胰島素", "備註"],
    rows.map((row) => [row.time || row.date || "", row.glucose || row.value || "", row.insulin || "", row.note || ""]),
    "glucose-table"
  );
}

function aiAssessment(ai) {
  if (!ai) return `<div class="empty">尚未產生 AI 判讀。</div>`;
  return `
    <div class="ai-banner"><strong>AI 輔助判讀</strong><span>請保留來源核對，不取代醫師判斷。</span></div>
    <pre class="summary-text">${escapeHtml(ai.summary || "")}</pre>
    <section class="ai-trend-section">
      <h3>抽血趨勢表</h3>
      ${ai.labTrends?.length ? table(
        ["項目", "最新", "前值", "變化", "參考值", "時間"],
        ai.labTrends.map((row) => [
          row.item,
          labValueHtml(row),
          row.previous || "",
          trendLabel(row),
          row.ref || "",
          row.time || "",
        ]),
        "ai-trend-table"
      ) : missingDataState()}
    </section>
    <div class="context-grid">
      <section><h3>可能病情變化</h3>${bulletList(ai.priorities)}</section>
      <section><h3>注意事項</h3>${bulletList(ai.cautions)}</section>
    </div>
  `;
}

function trendLabel(row = {}) {
  const direction = row.direction === "up" ? "上升" : row.direction === "down" ? "下降" : row.direction === "flat" ? "持平" : "";
  const delta = row.delta !== "" && row.delta !== undefined ? ` (${row.delta > 0 ? "+" : ""}${row.delta})` : "";
  const className = row.direction ? `trend-${escapeHtml(row.direction)}` : "";
  return direction ? `<span class="${className}">${escapeHtml(direction + delta)}</span>` : "";
}

function bulletList(items = []) {
  return `<ul class="bullet-list">${(items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
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

function isTrustedHtml(value) {
  const text = String(value ?? "");
  return text.startsWith("<span") || text.startsWith("<details");
}

function missingDataState() {
  return `<div class="empty">尚未擷取資料。請先查詢病人；若仍無資料，可能是 Onepage session 失效或此來源 parser 尚未接上。</div>`;
}

function parseDisplayTime(value) {
  const time = new Date(String(value || "").replace(/\//g, "-")).getTime();
  return Number.isNaN(time) ? 0 : time;
}

el.savePin.addEventListener("click", () => {
  state.pin = el.pin.value.trim();
  localStorage.setItem("shadowPin", state.pin);
  setStatus(state.pin ? "PIN 已儲存" : "等待 PIN");
});

el.loadWard.addEventListener("click", loadWard);
el.loadSummary.addEventListener("click", () => loadSummary());
el.refreshPatient.addEventListener("click", () => {
  const entry = currentEntry();
  if (entry) loadSummary(entry.key);
});
el.clearPatients.addEventListener("click", () => {
  state.patients = [];
  state.currentKey = "";
  renderRoster();
  renderPatientTabs();
  el.patientTitle.textContent = "尚未選擇";
  el.patientMeta.textContent = "先輸入 PIN，再查醫師清單或病人摘要。";
  el.resultPanel.innerHTML = `<div class="empty">尚未選擇病人。</div>`;
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
  renderPatientTabs();
  renderCurrentPatient();
});

el.dataTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]")?.dataset?.tab;
  if (!tab) return;
  state.currentTab = tab;
  renderDataTabs();
  renderPanel();
});
