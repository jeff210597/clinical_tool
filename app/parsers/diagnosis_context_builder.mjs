const NEGATIVE_OR_EMPTY = /^(無|沒有|不詳|否|nil|none|n\/a|unknown|無有|無 不詳 有)$/i;
const NOISE_WORDS = /^(內科病史|外科病史|其他病史|過敏史|家族病史)\s*[:：]?\s*(無|不詳|有|\s)*$/;
const FIELD_NOISE = /^(內科病史|外科病史|其他病史|過敏史|家族病史)(無|不詳|有)*$/;
const PROCEDURE_NOISE = /\b(?:port\s*a|chest\s*pa|echocardiography|m-mode|sector|ct|sono|ekg|ng|nasogastric|endo(?:tracheal)?|cvc|central venous|foley|catheter|tube|intubation|insertion)\b/i;

export function buildDiagnosisContext(patient) {
  const assessment = patient.clinicalContext?.adultAdmissionAssessment || null;
  const evidence = collectEvidence(patient, assessment);
  const diagnosis = buildDiagnosis(patient, assessment);
  const pastHistory = buildPastHistory(assessment, diagnosis);

  return {
    currentDiagnoses: diagnosis.map(toSourceItem),
    pastHistory: pastHistory.map(toSourceItem),
    admissionReason: patient.clinicalContext?.admissionReason || null,
    adultAdmissionAssessment: assessment,
    aiIntegrated: {
      mode: "adult_assessment_primary",
      generatedAt: new Date().toISOString(),
      explicitDiagnoses: diagnosis,
      importantHistory: pastHistory,
      inferredItems: [],
      evidence,
    },
    sourceExtracts: patient.clinicalContext?.sourceExtracts || [],
  };
}

function collectEvidence(patient, assessment) {
  const out = [];
  if (assessment?.admissionReason) {
    out.push(evidenceItem("diagnosis", "成人入院評估", "adult_assessment", assessment.capturedAt || "", assessment.admissionReason, "high"));
  }
  if (assessment?.pastHistory) {
    for (const part of cleanParts(assessment.pastHistory)) {
      out.push(evidenceItem("history", "成人入院評估", "adult_assessment", assessment.capturedAt || "", part, "high"));
    }
  }
  for (const surgery of patient.surgeries || []) {
    const text = [surgery.diagPre, surgery.diagPost, surgery.procedure, surgery.operation].filter(Boolean).join("; ");
    if (text) out.push(evidenceItem("surgery_reference", "手術紀錄", "surgeries", surgery.date || surgery.start || "", text, "medium"));
  }
  return out.filter((item) => item.text);
}

function buildDiagnosis(patient, assessment) {
  const sourceText = cleanText(assessment?.admissionReason || patient.clinicalContext?.admissionReason?.text || "");
  const surgeryCorpus = surgeryText(patient.surgeries || []);
  const surgeryDisease = canonicalDiagnosis(surgeryCorpus);
  const disease = surgeryDisease || canonicalDiagnosis(sourceText);
  if (disease) {
    const surgeryStatus = surgeryStatusForDiagnosis(patient.surgeries || [], disease);
    return [makeItem({
      kind: "diagnosis",
      label: [disease, surgeryStatus].filter(Boolean).join(" "),
      text: sourceText,
      source: "成人入院評估",
      sourceKey: "adult_assessment",
      date: assessment?.capturedAt || "",
      confidence: "high",
    })];
  }

  const fallback = cleanParts(sourceText)
    .map((part) => canonicalDiagnosis(part) || part)
    .filter((part) => part && !isNoise(part));
  return uniqueLabels(fallback).slice(0, 3).map((label) => makeItem({
    kind: "diagnosis",
    label,
    text: sourceText || label,
    source: "成人入院評估",
    sourceKey: "adult_assessment",
    date: assessment?.capturedAt || "",
    confidence: sourceText ? "high" : "low",
  }));
}

function buildPastHistory(assessment, diagnosis) {
  const diagnosisTopic = diagnosisTopicKey(diagnosis[0]?.label || "");
  const labels = [];
  for (const part of cleanParts(assessment?.pastHistory || "")) {
    const label = canonicalHistory(part);
    if (!label || sameTopic(label, diagnosisTopic)) continue;
    labels.push(label);
  }

  return uniqueLabels(labels).slice(0, 8).map((label) => makeItem({
    kind: "history",
    label,
    text: label,
    source: "成人入院評估",
    sourceKey: "adult_assessment",
    date: assessment?.capturedAt || "",
    confidence: "high",
  }));
}

function canonicalDiagnosis(text) {
  const value = cleanText(text);
  if (/(大腸癌|結腸癌|直腸癌|colon cancer|rectal cancer|colorectal cancer|adenocarcinoma)/i.test(value)) {
    return "Rectal/colorectal cancer";
  }
  if (/(肛門廔管|anal fistula)/i.test(value)) return "Anal fistula";
  if (/(痔瘡|hemorrhoid)/i.test(value)) return "Hemorrhoid";
  return "";
}

function canonicalHistory(text) {
  const value = cleanText(text);
  if (!value || isNoise(value)) return "";
  if (/(過敏性鼻炎|allergic rhinitis|hypertrophic rhinitis|turbinectomy)/i.test(value)) {
    return "Allergic Rhinitis with chronic hypertrophic rhinitis";
  }
  return canonicalDiagnosis(value) || value;
}

function surgeryStatusForDiagnosis(surgeries, disease) {
  if (!/cancer|fistula|hemorrhoid/i.test(disease)) return "";
  const corpus = surgeryText(surgeries);
  if (/robotic\s+LAR|low anterior resection|\bLAR\b/i.test(corpus)) return "s/p LAR";
  if (/colectomy|hemicolectomy|resection|切除/i.test(corpus)) return "s/p surgical resection";
  if (/fistulectomy/i.test(corpus) && /hemorrhoidectomy/i.test(corpus)) return "s/p Fistulectomy and partial hemorrhoidectomy";
  if (/fistulectomy/i.test(corpus)) return "s/p Fistulectomy";
  return "";
}

function cleanParts(text) {
  return String(text || "")
    .split(/\n|;|；|，|。/)
    .map((part) => cleanText(part))
    .filter((part) => part && !isNoise(part));
}

function isNoise(text) {
  const value = cleanText(text).replace(/[，,。；;：:\s]/g, "");
  return !value || NEGATIVE_OR_EMPTY.test(value) || NOISE_WORDS.test(cleanText(text)) || FIELD_NOISE.test(value) || PROCEDURE_NOISE.test(value);
}

function surgeryText(surgeries) {
  return surgeries.map((row) => [row.diagPre, row.diagPost, row.procedure, row.operation].filter(Boolean).join(" ")).join("\n");
}

function sameTopic(label, topic) {
  if (!topic) return false;
  const key = diagnosisTopicKey(label);
  return key && key === topic;
}

function diagnosisTopicKey(value) {
  const text = String(value || "").toLowerCase();
  if (/大腸癌|結腸癌|直腸癌|colon|rectal|colorectal|adenocarcinoma/.test(text)) return "colorectal_cancer";
  if (/anal fistula|肛門廔管/.test(text)) return "anal_fistula";
  if (/hemorrhoid|痔瘡/.test(text)) return "hemorrhoid";
  if (/rhinitis|鼻炎/.test(text)) return "rhinitis";
  return normalizeKey(text);
}

function uniqueLabels(labels) {
  const seen = new Set();
  const out = [];
  for (const label of labels) {
    const key = diagnosisTopicKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function evidenceItem(kind, source, sourceKey, date, text, confidence) {
  return makeItem({ kind, label: cleanText(text).slice(0, 160), text, source, sourceKey, date, confidence });
}

function makeItem({ kind, label, text, source, sourceKey, date, confidence }) {
  return {
    kind,
    label: cleanText(label),
    text: cleanText(text || label),
    source,
    sourceKey,
    date,
    confidence,
    status: "明確",
  };
}

function toSourceItem(item) {
  return {
    source: `${item.source}${item.date ? ` ${item.date}` : ""}`,
    text: item.text,
    confidence: item.confidence,
    status: item.status,
  };
}

function cleanText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\bASORDER\b/gi, "")
    .replace(/^[:：]+|[:：]+$/g, "")
    .trim()
    .slice(0, 900);
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}
