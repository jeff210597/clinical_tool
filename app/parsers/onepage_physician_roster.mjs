const DEFAULT_ONEPAGE_BASE = "http://10.125.10.11:8040";
const DEFAULT_APP_TOKEN = "app_tok_9c34eefcdfffc2e66c30f4cb6885e22d";

export async function fetchPhysicianInpatients({
  doctorId,
  onepageBase = DEFAULT_ONEPAGE_BASE,
  appToken = process.env.ONEPAGE_APP_TOKEN || DEFAULT_APP_TOKEN,
  authToken = process.env.ONEPAGE_AUTH_TOKEN || "",
  fetchImpl = fetch,
}) {
  const id = String(doctorId || "").trim();
  if (!id) throw new Error("doctorId is required");
  if (!authToken) {
    return {
      physician: { id, name: "" },
      patients: [],
      status: "missing_auth",
      message: "Onepage auth token is missing. Please login first.",
    };
  }

  const rows = await postOnepageApi({
    onepageBase,
    path: "ipd.list",
    params: { doc_id: id, combine_care_doc_id: id, current: true },
    appToken,
    authToken,
    fetchImpl,
  });

  const patients = (Array.isArray(rows) ? rows : rows ? [rows] : [])
    .map((row) => normalizeRosterPatient(row, id))
    .filter((row) => row.chartNo || row.bedNo || row.feeNo)
    .sort(compareBedNo);

  return {
    physician: {
      id,
      name: firstValue(rows?.[0]?.doc_name, rows?.[0]?.doctor_name, rows?.[0]?.docName),
    },
    patients,
    status: "ok",
    message: patients.length ? `已取得 ${patients.length} 位住院病人。` : "查無目前住院病人。",
  };
}

function normalizeRosterPatient(row = {}, doctorId = "") {
  const docId = firstValue(row.doc_id, row.doctor_id, row.docId);
  return {
    chartNo: firstValue(row.chr_no, row.chart_no, row.chartNo, row.histno, row.patient_id, row.no),
    name: firstValue(row.name, row.pt_name, row.patient_name),
    bedNo: firstValue(row.bed_no, row.bed, row.bedNo),
    feeNo: firstValue(row.fee_no, row.feeno, row.feeNo, row.fee_no_ori),
    dept: firstValue(row.dept_name, row.dept, row.div_name),
    doctorId: docId,
    combineCare: !!doctorId && !!docId && String(docId).trim() !== String(doctorId).trim(),
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

function compareBedNo(a, b) {
  return String(a.bedNo || "").localeCompare(String(b.bedNo || ""), "zh-Hant", { numeric: true, sensitivity: "base" });
}

function firstValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}
