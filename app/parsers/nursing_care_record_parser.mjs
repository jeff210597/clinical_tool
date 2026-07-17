const DEFAULT_NIS_BASE = "http://10.125.254.46/NIS";

export async function fetchNursingCareRecords({ feeno, nisBase = DEFAULT_NIS_BASE, fetchImpl = fetch }) {
  const feeNo = String(feeno || "").trim();
  if (!feeNo) throw new Error("feeno is required");
  const url = `${nisBase.replace(/\/$/, "")}/HISVIEW/CareRecord?feeno=${encodeURIComponent(feeNo)}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      feeno: feeNo,
      start_date: "2000/01/01",
      start_time: "00:00",
      end_date: todayText(),
      end_time: "23:59",
    }),
  });
  if (!response.ok) throw new Error(`nursing care record request failed: ${response.status}`);
  return {
    source: "NIS HISView > 護理紀錄",
    endpoint: "HISVIEW/CareRecord",
    rows: parseNursingCareRecords(await response.text()),
  };
}

function todayText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

export function parseNursingCareRecords(html) {
  const rows = [...String(html || "").matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
  const records = [];

  for (const rowHtml of rows) {
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => cleanText(match[1]));
    if (cells.length < 3) continue;
    const time = cells.find((cell) => /\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}/.test(cell)) || "";
    const author = cells.find((cell, index) => index > 1 && cell && cell.length <= 12 && !/[：:]/.test(cell)) || "";
    const note = cells
      .filter((cell) => cell && cell !== time && cell !== author && !/^時間日期$|^紀錄$|^輸入者$/.test(cell))
      .join("\n")
      .trim();
    if (!time || !note) continue;
    records.push({
      time,
      type: inferType(note),
      note,
      author,
    });
  }

  return records.sort((a, b) => parseTime(b.time) - parseTime(a.time));
}

// CareRecord is returned newest-first.  The first *useful* admission note is
// more reliable than blindly using the first row: early rows can be a single
// vital sign, teaching entry, or handover instead of the nursing assessment.
export function selectNursingAdmissionAssessment(rows = []) {
  const chronological = [...(Array.isArray(rows) ? rows : [])]
    .filter((row) => String(row?.note || "").trim())
    .sort((a, b) => parseTime(a.time) - parseTime(b.time));
  if (!chronological.length) return null;

  const meaningful = chronological.filter((row) => isMeaningfulAssessment(row.note));
  const marked = chronological.find((row) => isAdmissionMarked(row.note) && String(row.note || "").trim().length >= 40);
  const record = marked || meaningful[0] || null;
  if (!record) return null;

  const explicitHistory = extractPastHistory(record.note);
  const historicalCourse = explicitHistory ? "" : extractHistoricalCourse(record.note);
  const pastHistory = explicitHistory || historicalCourse;
  return {
    time: record.time || "",
    author: record.author || "",
    type: record.type || "護理紀錄",
    rawNote: String(record.note || "").trim(),
    pastHistory,
    historyKind: explicitHistory ? "explicit_history" : (historicalCourse ? "historical_course" : "none"),
    status: pastHistory ? "identified" : "no_confirmed_history",
    source: historicalCourse ? "NIS 護理入院評估：既往病程" : "NIS 護理入院評估",
  };
}

function isMeaningfulAssessment(note) {
  const text = String(note || "").trim();
  if (text.length < 80) return false;
  if (/^(?:T|P|R|BP|SpO2|O)\s*[:：]/i.test(text) && text.length < 180) return false;
  return true;
}

function isAdmissionMarked(note) {
  return /\bAdmitted\s+at\b|入院(?:評估|紀錄|時|後)?|admission assessment/i.test(String(note || ""));
}

function extractPastHistory(note) {
  const text = String(note || "").replace(/\r/g, "").trim();
  const labels = [
    "過去病史", "既往病史", "內科病史", "外科病史", "手術史",
    "慢性病", "長期用藥", "藥物史", "過敏史", "PMH", "Past medical history",
  ];
  const labelPattern = labels.map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?:^|[\\n；;。])\\s*(${labelPattern})\\s*[:：]\\s*([\\s\\S]*?)(?=(?:[\\n；;。])\\s*(?:${labelPattern}|[SOAPHI])\\s*[:：]|$)`, "ig");
  const sections = [];
  for (const match of text.matchAll(pattern)) {
    const value = cleanHistoryText(match[2]);
    if (value) sections.push(`${match[1]}：${value}`);
  }
  return [...new Set(sections)].join("\n");
}

function extractHistoricalCourse(note) {
  const sentences = String(note || "")
    .split(/[\n；;。]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const datePattern = /(?:\d{2,4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}|今年\d{1,2}月)/;
  const coursePattern = /病理|切片|手術|化療|電療|放療|追蹤|術後|治療|診斷|adenocarcinoma|carcinoma|cancer/i;
  const selected = sentences.filter((sentence) => datePattern.test(sentence) && coursePattern.test(sentence));
  return [...new Set(selected)].join("；");
}

function cleanHistoryText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[；;]\s*$/, "")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferType(note) {
  const firstLine = String(note || "").split(/\n/).find(Boolean) || "";
  const match = firstLine.match(/^([^：:]{1,12}[：:])/);
  return match ? match[1].replace(/[：:]/, "") : "護理紀錄";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function cleanText(value) {
  return htmlDecode(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>\s*<div[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseTime(value) {
  const time = new Date(String(value || "").replace(/\//g, "-")).getTime();
  return Number.isNaN(time) ? 0 : time;
}
