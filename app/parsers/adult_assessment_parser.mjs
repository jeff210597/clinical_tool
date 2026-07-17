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
  const staticFields = extractSubtitleFields(html);
  const scriptFields = extractScriptFields(html);
  const fields = {
    ...staticFields,
    "入院原因": scriptFields.param_ipd_reason || staticFields["入院原因"] || "",
    "內科病史": buildMedicalHistory(scriptFields, staticFields),
    "外科病史": buildSurgicalHistory(scriptFields, staticFields),
    "其他病史": selectedScriptText(scriptFields, "param_other_history", ["param_other_history_desc"]) || staticFields["其他病史"] || "",
    "過敏史": selectedScriptText(scriptFields, "param_allergy_history", ["param_allergy_history_desc"]) || staticFields["過敏史"] || "",
    "家族病史": selectedScriptText(scriptFields, "param_family_history", ["param_family_history_desc"]) || staticFields["家族病史"] || "",
  };
  const get = (...names) => {
    for (const name of names) {
      const value = fields[name];
      if (value) return value;
    }
    return "";
  };

  const pastHistoryParts = [
    fieldLine("內科病史", get("內科病史"), { omitNegative: true }),
    fieldLine("外科病史", get("外科病史"), { omitNegative: true }),
    fieldLine("其他病史", get("其他病史"), { omitNegative: true }),
    fieldLine("過敏史", get("過敏史"), { omitNegative: true }),
    fieldLine("家族病史", get("家族病史"), { omitNegative: true }),
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

  const hasContent = Boolean(get("入院原因") || pastHistoryParts.length || functionalParts.length);
  return {
    source: "護理查詢 > 成人入院評估單",
    status: hasContent ? "ok" : "empty",
    capturedAt: new Date().toISOString(),
    admissionReason: get("入院原因"),
    pastHistory: pastHistoryParts.join("；"),
    pastHistoryStatus: pastHistoryParts.length ? "reported" : (hasHistoryResponse(fields) ? "reported_none" : "not_provided"),
    functionalAssessment: functionalParts.join("；"),
    fields,
    rawSourceRef: null,
  };
}

function extractScriptFields(html) {
  const fields = {};
  const pattern = /set_for_(?:txt|rb|cb)\(\s*'((?:\\.|[^'])*)'\s*,\s*'((?:\\.|[^'])*)'\s*\)/g;
  for (const match of String(html || "").matchAll(pattern)) {
    const name = decodeJsString(match[1]);
    const value = decodeJsString(match[2]);
    if (name) fields[name] = value;
  }
  return fields;
}

function decodeJsString(value) {
  return htmlDecode(String(value || "")
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim());
}

function selectedScriptText(scriptFields, selectedField, detailFields) {
  if (String(scriptFields[selectedField] || "").trim() !== "有") return "";
  return detailFields
    .map((name) => cleanText(scriptFields[name] || ""))
    .filter(Boolean)
    .join("；");
}

function buildMedicalHistory(scriptFields, staticFields) {
  const text = selectedScriptText(scriptFields, "param_im_history", [
    "param_im_history_item1", "param_im_history_item2", "param_im_history_item3", "param_im_history_item4",
    "param_im_history_item_other_txt", "param_im_history_status",
  ]);
  return text || staticFields["內科病史"] || "";
}

function buildSurgicalHistory(scriptFields, staticFields) {
  const text = selectedScriptText(scriptFields, "param_su_history", [
    "param_su_history_trauma_txt", "param_su_history_surgery_txt", "param_su_history_other_txt",
  ]);
  return text || staticFields["外科病史"] || "";
}

function fieldLine(label, value, options = {}) {
  const text = String(value || "").trim();
  if (!text || (options.omitNegative && isNegativeHistoryValue(text))) return "";
  return `${label}: ${text}`;
}

function isNegativeHistoryValue(value) {
  return /^(?:無|否認|none|nil|no)(?:\s*(?:特殊|病史|過敏|remarkable))?$/i.test(String(value || "").trim());
}

function hasHistoryResponse(fields) {
  return ["內科病史", "外科病史", "其他病史", "過敏史", "家族病史"].some((name) => String(fields[name] || "").trim());
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
  let hasChoiceControl = false;

  for (const match of block.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    pushClean(values, match[1]);
  }

  for (const match of block.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1];
    const type = getAttr(attrs, "type").toLowerCase();
    const value = getAttr(attrs, "value");
    const checked = /(?:^|\s)checked(?:\s|=|$)/i.test(attrs);

    if (type === "text" || type === "hidden") {
      pushClean(values, value);
    } else if (type === "radio" || type === "checkbox") {
      hasChoiceControl = true;
      if (checked) pushClean(values, value);
    }
  }

  const visibleText = cleanText(
    block
      .replace(/<label[^>]*class=["']subtitle["'][^>]*>[\s\S]*?<\/label>/i, "")
      .replace(/<input\b[^>]*>/gi, "")
      .replace(/<textarea\b[\s\S]*?<\/textarea>/gi, "")
  );
  // Radio / checkbox labels are form choices, not patient data.  Never use
  // their visible text as a fallback when no option was actually selected.
  if (!values.length && !hasChoiceControl) pushClean(values, visibleText);

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
