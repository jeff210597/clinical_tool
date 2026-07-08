const DEFAULT_ONEPAGE_BASE = "http://10.125.10.11:8040";
const DEFAULT_APP_TOKEN = "app_tok_9c34eefcdfffc2e66c30f4cb6885e22d";

const SOURCE_CONFIG = {
  labs: {
    endpoints: ["lab.list", "labs.list", "labresult.list", "labresults.list", "lab.list2", "lab", "lis.list"],
    normalize: normalizeLabs,
  },
  imaging: {
    endpoints: ["imageManager.list", "images.list", "image.list", "exam.image.list", "exam.list"],
    normalize: normalizeImaging,
  },
  surgeries: {
    endpoints: ["surgery.list", "surgeries.list", "operation.list", "operations.list"],
    normalize: normalizeSurgeries,
  },
  nursing: {
    endpoints: ["nursing.list", "nursing_note.list", "nursing.notes", "notes.nursing.list"],
    normalize: normalizeNursing,
  },
};

export async function fetchOnepageClinicalSource({
  source,
  feeno,
  chartNo = "",
  authToken,
  onepageBase = DEFAULT_ONEPAGE_BASE,
  appToken = process.env.ONEPAGE_APP_TOKEN || DEFAULT_APP_TOKEN,
  fetchImpl = fetch,
}) {
  const config = SOURCE_CONFIG[source];
  if (!config) throw new Error(`unsupported clinical source: ${source}`);
  if (!String(feeno || "").trim()) throw new Error("feeno is required");
  if (!authToken) throw new Error("Onepage auth token is required");
  if (source === "imaging") {
    return fetchCombinedImaging({ feeno, chartNo, onepageBase, appToken, authToken, fetchImpl });
  }

  const errors = [];
  let emptyResult = null;
  for (const endpoint of config.endpoints) {
    try {
      const payload = await postOnepageApi({
        onepageBase,
        path: endpoint,
        params: source === "labs" ? labRequestParams(chartNo) : requestParams(feeno, chartNo),
        appToken,
        authToken,
        fetchImpl,
      });
      const rows = toRows(payload);
      const enrichedRows = source === "imaging" && endpoint === "image.list"
        ? await enrichImageRows({ rows, feeno, chartNo, onepageBase, appToken, authToken, fetchImpl })
        : rows;
      const normalized = config.normalize(enrichedRows);
      if (!normalized.length && !rows.length && !emptyResult) {
        emptyResult = { source, endpoint, rows: [], raw: [] };
      }
      if (normalized.length) {
        return { source, endpoint, rows: normalized, raw: enrichedRows };
      }
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }

  if (emptyResult) return emptyResult;
  throw new Error(errors.slice(0, 3).join(" | ") || "no Onepage endpoint returned data");
}

async function fetchCombinedImaging({ feeno, chartNo, onepageBase, appToken, authToken, fetchImpl }) {
  const endpoints = [
    { endpoint: "image.list", sourceType: "Image" },
    { endpoint: "exam.list", sourceType: "Exam" },
    { endpoint: "exams.list", sourceType: "Exam" },
    { endpoint: "examManager.list", sourceType: "Exam" },
  ];
  const errors = [];
  const allRows = [];
  const usedEndpoints = [];

  for (const { endpoint, sourceType } of endpoints) {
    try {
      const payload = await postOnepageApi({
        onepageBase,
        path: endpoint,
        params: sourceType === "Image" ? imageRequestParams(chartNo) : requestParams(feeno, chartNo),
        appToken,
        authToken,
        fetchImpl,
      });
      let rows = toRows(payload).map((row) => ({ ...row, sourceType }));
      const normalized = normalizeImaging(rows);
      if (normalized.length) {
        usedEndpoints.push(endpoint);
        allRows.push(...normalized);
      }
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }

  const rows = uniqueClinicalRows(sortByTimeDesc(allRows, (row) => row.date));
  if (rows.length) return { source: "imaging", endpoint: usedEndpoints.join("+"), rows, raw: rows };
  return { source: "imaging", endpoint: usedEndpoints.join("+") || "imaging+exam", rows: [], raw: [], errors: errors.slice(0, 3) };
}

async function postOnepageApi({ onepageBase, path, params, appToken, authToken, fetchImpl }) {
  const base = String(onepageBase || DEFAULT_ONEPAGE_BASE).replace(/\/$/, "");
  const response = await fetchImpl(`${base}/api/${path}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: base,
      referer: `${base}/mypage`,
      "x-app-token": appToken,
      "x-wfauth": authToken,
    },
    body: JSON.stringify(params || {}),
  });

  const text = await response.text();
  if (!response.ok) {
    const body = text ? ` ${text.slice(0, 160)}` : "";
    throw new Error(`HTTP ${response.status}${body}`);
  }
  if (!text.trim()) return [];
  return JSON.parse(text);
}

function toRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.rows)) return payload.data.rows;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.result)) return payload.data.result;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.records)) return payload.records;
  if (payload && typeof payload === "object") {
    const groupedRows = [];
    for (const [group, value] of Object.entries(payload)) {
      if (!Array.isArray(value)) continue;
      for (const row of value) groupedRows.push({ ...row, group });
    }
    if (groupedRows.length) return groupedRows;
  }
  return payload && typeof payload === "object" ? [payload] : [];
}

function normalizeLabs(rows) {
  return sortByTimeDesc(rows.map((row) => ({
    item: firstValue(row.item, row.name, row.test_name, row.lab_name, row.labName, row.exam_name, row.order_name, row.display_name, row.檢驗項目, row.項目),
    latest: firstValue(row.latest, row.value, row.val, row.result, row.result_value, row.resultValue, row.report_value, row.value_text, row.結果, row.數值),
    unit: firstValue(row.unit, row.units, row.unit_name, row.單位),
    time: formatDateTime(combineDateTime(firstValue(row.date, row.report_date, row.result_date, row.order_date), firstValue(row.time, row.report_time, row.result_time)) || firstValue(row.time, row.date, row.report_time, row.result_time, row.create_time, row.時間)),
    previous: firstValue(row.previous, row.prev_value, row.last_value),
    trend: firstValue(row.trend, row.diff, row.delta),
    flag: firstValue(row.flag, row.mark, row.abnormal_flag, row.abnormal, row.hl, row.status),
    group: firstValue(row.group, row.kind, row.category, row.table, row.sourceType),
    ref: firstValue(row.ref, row.reference, row.reference_range, row.normal_range, row.range, row.參考值),
  })).filter((row) => row.item || row.latest), (row) => row.time);
}

function normalizeImaging(rows) {
  return sortByTimeDesc(rows.map((row) => ({
    date: formatDate(row.sourceType === "Image"
      ? firstValue(row.date, row.exam_date, row.order_date, row.report_date, row.v_date, row.report_time, row.日期)
      : firstValue(row.report_date, row.date, row.exam_date, row.order_date, row.report_time, row.日期)),
    type: firstValue(row.type, row.exam_name, row.name, row.title, row.modality, row.order_name, row.檢查名稱) || "影像",
    source: firstValue(row.sourceType, row.source) || "Image",
    impression: cleanReport(firstValue(row.impression, row.content, row.html_report, row.report, row.result, row.finding, row.findings, row.report_text, row.報告)),
    report: cleanReport(firstValue(row.content, row.html_report, row.report, row.result, row.finding, row.findings, row.report_text, row.報告)),
  })).filter((row) => row.type || row.impression || row.report), (row) => row.date);
}

function requestParams(feeno, chartNo) {
  return {
    fee_no: String(feeno).trim(),
    feeno: String(feeno).trim(),
    chart_no: String(chartNo || "").trim(),
    chr_no: String(chartNo || "").trim(),
  };
}

function labRequestParams(chartNo) {
  const value = String(chartNo || "").trim();
  return {
    chr_no: value,
    no: value,
  };
}

function imageRequestParams(chartNo) {
  const value = String(chartNo || "").trim();
  return {
    chr_no: value,
    no: value,
    content: true,
    current: false,
  };
}

function uniqueClinicalRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [row.source, row.date, row.type, row.impression || row.report].join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function enrichImageRows({ rows, feeno, chartNo, onepageBase, appToken, authToken, fetchImpl }) {
  const enriched = [];
  for (const row of rows.slice(0, 30)) {
    try {
      const detail = await postOnepageApi({
        onepageBase,
        path: "image.get",
        params: {
          id: firstValue(row.id),
          data_id: firstValue(row.id),
          acc_seq: firstValue(row.acc_seq),
          fee_no: String(feeno || "").trim(),
          feeno: String(feeno || "").trim(),
          chart_no: String(chartNo || "").trim(),
        },
        appToken,
        authToken,
        fetchImpl,
      });
      enriched.push({ ...row, ...(Array.isArray(detail) ? detail[0] : detail) });
    } catch {
      enriched.push(row);
    }
  }
  return enriched;
}

function normalizeSurgeries(rows) {
  return sortByTimeDesc(rows.map((row) => ({
    date: formatDate(firstValue(row.date, row.op_date, row.operation_date)),
    procedure: firstValue(row.surgery, row.procedure, row.operation, row.op_name, row.name, row.title),
    operation: firstValue(row.operation),
    room: firstValue(row.room),
    dept: firstValue(row.dept),
    key: firstValue(row.key),
    no: firstValue(row.no),
    start: formatDateTime(firstValue(row.start)),
    end: formatDateTime(firstValue(row.end)),
    finishDate: formatDateTime(firstValue(row.finish_date)),
    diagPre: firstValue(row.diag_pre),
    diagPost: firstValue(row.diag_post),
    indication: firstValue(row.indication),
    complication: firstValue(row.complication),
    bloodLoss: firstValue(row.blood_loss),
    finding: firstValue(row.finding),
    antibioticsUsed: row.is_antibiotics_used === true ? "是" : row.is_antibiotics_used === false ? "否" : "",
    surgeon: firstValue(row.surgeon, row.operator, row.doctor) || formatPeople(row.person?.doctor),
    resident: formatPeople(row.person?.resident),
    scrubNurse: formatPeople(row.person?.["scrubbing nurse"]),
    circulatingNurse: formatPeople(row.person?.["circulating nurse"]),
    anesthesia: firstValue(row.anesthesia),
    codes: Array.isArray(row.code) ? row.code.join(", ") : firstValue(row.code),
    note: firstValue(row.note, row.summary, row.record, row.report, row.finding),
  })).filter((row) => row.date || row.procedure || row.note), (row) => row.date);
}

function formatPeople(value) {
  if (!Array.isArray(value)) return "";
  return value.map((person) => [person.id, person.name].filter(Boolean).join(" ")).filter(Boolean).join(", ");
}
function normalizeNursing(rows) {
  return sortByTimeDesc(rows.map((row) => ({
    time: formatDateTime(firstValue(row.time, row.date, row.record_time, row.時間)),
    type: firstValue(row.type, row.category, row.title, row.類別) || "護理紀錄",
    note: firstValue(row.note, row.content, row.record, row.text, row.內容),
  })).filter((row) => row.time || row.note), (row) => row.time);
}

function firstValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function cleanReport(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function combineDateTime(date, time) {
  const dateText = firstValue(date);
  const timeText = firstValue(time);
  if (!dateText) return "";
  if (!timeText || dateText.includes(":")) return dateText;
  return `${dateText} ${timeText}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function sortByTimeDesc(rows, getValue) {
  return rows.sort((a, b) => parseTime(getValue(b)) - parseTime(getValue(a)));
}

function parseTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
