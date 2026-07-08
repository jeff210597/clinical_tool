const DEFAULT_ONEPAGE_BASE = "http://10.125.10.11:8040";
const DEFAULT_APP_TOKEN = "app_tok_9c34eefcdfffc2e66c30f4cb6885e22d";

export async function fetchOnepageVitals({
  feeno,
  authToken,
  onepageBase = DEFAULT_ONEPAGE_BASE,
  appToken = process.env.ONEPAGE_APP_TOKEN || DEFAULT_APP_TOKEN,
  fetchImpl = fetch,
}) {
  const feeNo = String(feeno || "").trim();
  if (!feeNo) throw new Error("feeno is required for vitals.list");
  if (!authToken) throw new Error("Onepage auth token is required for vitals.list");

  const rows = await postOnepageApi({
    onepageBase,
    path: "vitals.list",
    params: { fee_no: feeNo },
    appToken,
    authToken,
    fetchImpl,
  });

  const raw = Array.isArray(rows) ? rows : [];
  const normalized = raw
    .map(normalizeVitalRow)
    .filter((row) => row.time)
    .sort((a, b) => parseTime(b.timeRaw || b.time) - parseTime(a.timeRaw || a.time));
  const vitalRows = normalized.filter(hasVitalSignal);

  return {
    raw,
    vitals: vitalRows.map(toVitalsRow),
    tpr: vitalRows.map(toTprRow),
    itpr: vitalRows.map(toItprRow),
  };
}

async function postOnepageApi({ onepageBase, path, params, appToken, authToken, fetchImpl }) {
  const base = String(onepageBase || DEFAULT_ONEPAGE_BASE).replace(/\/$/, "");
  const response = await fetchImpl(`${base}/api/${path}`, {
    method: "POST",
    headers: {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "origin": base,
      "referer": `${base}/mypage`,
      "x-app-token": appToken,
      "x-wfauth": authToken,
    },
    body: JSON.stringify(params || {}),
  });

  const text = await response.text();
  if (!response.ok) {
    const body = text ? ` ${text.slice(0, 200)}` : "";
    throw new Error(`HTTP ${response.status}${body}`);
  }
  if (!text.trim()) return [];
  return JSON.parse(text);
}

function normalizeVitalRow(row) {
  const sbp = firstValue(row.sbp, row.SBP);
  const dbp = firstValue(row.dbp, row.DBP);
  return {
    timeRaw: firstValue(row.date, row.time, row.datetime),
    time: formatDateTime(firstValue(row.date, row.time, row.datetime)),
    source: firstValue(row.source),
    bt: firstValue(row.bt, row.BT, row.temperature),
    rr: firstValue(row.rr, row.RR, row.respiration),
    pr: firstValue(row.pr, row.PR, row.hr, row.HR, row.pulse),
    sbp,
    dbp,
    bp: sbp || dbp ? `${sbp || ""}/${dbp || ""}` : "",
    spo2: firstValue(row.o2, row.spo2, row.SpO2),
    painScore: firstValue(row.ps, row.pain, row.pain_score),
    map: firstValue(row.map, row.MAP),
    height: firstValue(row.h, row.height),
    weight: firstValue(row.w, row.weight),
  };
}

function toVitalsRow(row) {
  return {
    time: row.time,
    bt: row.bt,
    rr: row.rr,
    hr: row.pr,
    sbp: row.sbp,
    dbp: row.dbp,
    spo2: row.spo2,
    painScore: row.painScore,
  };
}

function toTprRow(row) {
  return {
    time: row.time,
    t: row.bt,
    p: row.pr,
    r: row.rr,
    bp: row.bp,
    spo2: row.spo2,
  };
}

function toItprRow(row) {
  return {
    time: row.time,
    source: row.source || "iTPR",
    bt: row.bt,
    rr: row.rr,
    pr: row.pr,
    sbp: row.sbp,
    dbp: row.dbp,
    bp: row.bp,
    spo2: row.spo2,
    painScore: row.painScore,
    map: row.map,
    height: row.height,
    weight: row.weight,
  };
}

function hasVitalSignal(row) {
  return Boolean(row.bt || row.rr || row.pr || row.sbp || row.dbp || row.spo2 || row.painScore || row.map);
}

function firstValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function parseTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
