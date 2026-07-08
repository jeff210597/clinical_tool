const DEFAULT_NIS_BASE = "http://10.125.254.46/NIS";

export async function fetchAdultAdmissionAssessment({ feeno, nisBase = DEFAULT_NIS_BASE, fetchImpl = fetch }) {
  if (!feeno) throw new Error("feeno is required");
  const url = `${nisBase.replace(/\/$/, "")}/AdmissionAssessment/AssessmentAdult_PDF?feeno=${encodeURIComponent(feeno)}`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`adult assessment request failed: ${response.status}`);

  const html = await response.text();
  return parseAdultAdmissionAssessment(html);
}

export function parseAdultAdmissionAssessment(html) {
  const fields = extractSubtitleFields(html);
  const get = (...names) => {
    for (const name of names) {
      const value = fields[name];
      if (value) return value;
    }
    return "";
  };

  const pastHistoryParts = [
    fieldLine("內科病史", get("內科病史")),
    fieldLine("外科病史", get("外科病史")),
    fieldLine("其他病史", get("其他病史")),
    fieldLine("過敏史", get("過敏史")),
    fieldLine("家族病史", get("家族病史")),
  ].filter(Boolean);

  const functionalParts = [
    fieldLine("入院方式", get("入院方式")),
    fieldLine("主要照顧者", get("主要照顧者")),
    fieldLine("意識", get("意識")),
    fieldLine("活動", get("活動")),
    fieldLine("活動情形", get("活動情形")),
    fieldLine("關節活動度", get("關節活動度")),
    fieldLine("解尿", get("解尿")),
    fieldLine("大便", get("大便")),
    fieldLine("照顧特質", get("照顧特質")),
    fieldLine("照顧資源", get("照顧資源")),
    fieldLine("特殊照護", get("特殊照護")),
  ].filter(Boolean);

  return {
    source: "護理查詢 > 成人入院評估單",
    status: "ok",
    capturedAt: new Date().toISOString(),
    admissionReason: get("入院原因"),
    pastHistory: pastHistoryParts.join("；"),
    functionalAssessment: functionalParts.join("；"),
    fields,
    rawSourceRef: null,
  };
}

function fieldLine(label, value) {
  return value ? `${label}: ${value}` : "";
}

function extractSubtitleFields(html) {
  const fields = {};
  const blocks = [...String(html || "").matchAll(/<p\b[\s\S]*?<\/p>/gi)].map((match) => match[0]);
  for (const block of blocks) {
    const labelMatch = block.match(/<label[^>]*class=["']subtitle["'][^>]*>([\s\S]*?)<\/label>/i);
    if (!labelMatch) continue;
    const label = cleanText(labelMatch[1]);
    if (!label) continue;
    const value = extractBlockValue(block);
    if (value) fields[label] = value;
  }
  return fields;
}

function extractBlockValue(block) {
  const values = [];

  for (const match of block.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    pushClean(values, match[1]);
  }

  for (const match of block.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1];
    const type = getAttr(attrs, "type").toLowerCase();
    const value = getAttr(attrs, "value");
    const checked = /\bchecked(?:=["']?checked["']?)?/i.test(attrs);

    if (type === "text" || type === "hidden") {
      pushClean(values, value);
    } else if ((type === "radio" || type === "checkbox") && checked) {
      pushClean(values, value);
    }
  }

  const visibleText = cleanText(
    block
      .replace(/<label[^>]*class=["']subtitle["'][^>]*>[\s\S]*?<\/label>/i, "")
      .replace(/<input\b[^>]*>/gi, "")
      .replace(/<textarea\b[\s\S]*?<\/textarea>/gi, "")
  );
  if (!values.length) pushClean(values, visibleText);

  return [...new Set(values)].join(", ");
}

function getAttr(attrs, name) {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return htmlDecode(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function pushClean(values, value) {
  const cleaned = cleanText(value);
  if (cleaned) values.push(cleaned);
}

function cleanText(value) {
  return htmlDecode(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\|/g, ",")
    .replace(/\s+/g, " ")
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

export function buildAdultAssessmentWorkflow() {
  return [
    "進入 Onepage /{patient}/story",
    "定位目前住院 episode",
    "點擊護理查詢並取得 NIS/HISVIEW feeno",
    "直接讀取 /NIS/AdmissionAssessment/AssessmentAdult_PDF?feeno={feeno}",
    "解析入院原因、病史、功能與護理評估摘要",
  ];
}
