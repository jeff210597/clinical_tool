const DEFAULT_NIS_BASE = "http://10.125.254.46/NIS";

export async function fetchBloodSugarInsulin({ feeno, admissionStart = "", nisBase = DEFAULT_NIS_BASE, fetchImpl = fetch }) {
  const feeNo = String(feeno || "").trim();
  if (!feeNo) throw new Error("feeno is required");

  const primaryUrl = `${nisBase.replace(/\/$/, "")}/HISVIEW/BSugarInsulinList?feeno=${encodeURIComponent(feeNo)}`;
  const initialResponse = await fetchImpl(primaryUrl);
  if (!initialResponse.ok) throw new Error(`blood sugar insulin request failed: ${initialResponse.status}`);

  const initialHtml = await initialResponse.text();
  const query = parseBloodSugarQuery(initialHtml, feeNo, primaryUrl, admissionStart);
  const response = query
    ? await fetchImpl(query.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(query.fields).toString(),
    })
    : { ok: true, text: async () => initialHtml };
  if (!response.ok) throw new Error(`blood sugar insulin query failed: ${response.status}`);

  const html = await response.text();
  return {
    source: "NIS 血糖/胰島素",
    endpoint: "HISVIEW/BSugarInsulinList",
    capturedAt: new Date().toISOString(),
    querySubmitted: !!query,
    rows: parseBloodSugarInsulin(html),
  };
}

export function parseBloodSugarInsulin(html) {
  const rows = [];
  for (const rowHtml of extractRows(html)) {
    const cells = extractCells(rowHtml).map((cell) => cleanText(cell.html));
    if (cells.length < 3) continue;
    if (cells.some((cell) => /血糖監測時間|注射時間|病歷號|血糖\s*胰島素/.test(cell))) continue;
    if (!/\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}/.test(cells[0] || "")) continue;

    rows.push({
      glucoseTime: cells[0] || "",
      glucoseValue: cells[1] || "",
      monitor: cells[2] || "",
      injectionTime: cells[3] || "",
      medication: cells[4] || "",
      insulinDose: cells[5] || "",
      injectionSite: cells[6] || "",
      slidingScale: cells[7] || "",
      slidingDose: cells[8] || "",
      injector: cells[9] || "",
      rawCells: cells,
    });
  }

  return rows.sort((a, b) => parseTime(b.glucoseTime) - parseTime(a.glucoseTime));
}

function extractRows(html) {
  return [...String(html || "").matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
}

function extractCells(rowHtml) {
  return [...String(rowHtml || "").matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((match) => ({
    attrs: match[1] || "",
    html: match[2] || "",
  }));
}

function parseBloodSugarQuery(html, feeNo, baseUrl, admissionStart = "") {
  const formMatch = String(html || "").match(/<form\b([^>]*)>[\s\S]*?<\/form>/i);
  if (!formMatch) return null;

  const formAttrs = formMatch[1] || "";
  const action = attrValue(formAttrs, "action") || "BSugarInsulinList";
  const fields = { feeno: String(feeNo) };
  for (const match of formMatch[0].matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1] || "";
    const name = attrValue(attrs, "name");
    if (!name || !["feeno", "start_date", "start_time", "end_date", "end_time"].includes(name)) continue;
    fields[name] = attrValue(attrs, "value") || "";
  }

  if (!fields.start_date || !fields.end_date) return null;
  const admissionDate = formatNisDate(admissionStart);
  if (admissionDate && admissionDate < fields.start_date) fields.start_date = admissionDate;
  return { url: new URL(action, baseUrl).toString(), fields };
}

function formatNisDate(value) {
  const match = String(value || "").match(/(\d{3,4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return "";
  let year = Number(match[1]);
  if (year >= 100 && year < 300) year += 1911;
  if (year < 1900 || year > 2100) return "";
  return `${year}/${String(match[2]).padStart(2, "0")}/${String(match[3]).padStart(2, "0")}`;
}

function attrValue(attrs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(attrs || "").match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function cleanText(value) {
  return htmlDecode(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
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
