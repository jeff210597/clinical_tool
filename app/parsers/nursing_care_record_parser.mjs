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
