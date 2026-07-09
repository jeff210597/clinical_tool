const DIAGNOSIS_RULES = [
  {
    key: "sepsis",
    label: "Sepsis, unspecified organism",
    test: /sepsis|septicemia|敗血症|菌血症/i,
  },
  {
    key: "colorectal_cancer",
    label: "Rectal/colorectal cancer",
    test: /colorectal|rectal|colon|sigmoid|rectosigmoid|adenocarcinoma|carcinoma|malignan|大腸癌|直腸癌|結腸癌/i,
    procedure: /LAR|low anterior resection|colectomy|resection|robotic|laparoscopic|切除/i,
    procedureText: "s/p surgical resection",
  },
  {
    key: "anal_fistula",
    label: "Anal fistula",
    test: /anal fistula|肛門廔管|肛門瘻管/i,
    procedure: /fistulectomy|廔管切除|瘻管切除/i,
    procedureText: "s/p Fistulectomy",
  },
  {
    key: "hemorrhoid",
    label: "Hemorrhoid",
    test: /hemorrhoid|痔瘡/i,
    procedure: /hemorrhoidectomy|痔瘡切除/i,
    procedureText: "s/p hemorrhoidectomy",
  },
];

const HISTORY_RULES = [
  {
    key: "allergic_rhinitis",
    label: "Allergic Rhinitis with chronic hypertrophic rhinitis",
    test: /allergic rhinitis|hypertrophic rhinitis|chronic rhinitis|turbinectomy|鼻炎|鼻甲/i,
    procedure: /CO2 laser turbinectomy|laser turbinectomy|turbinectomy/i,
    procedureText: "s/p CO2 laser turbinectomy",
  },
  {
    key: "spinal_stenosis",
    label: "Low back pain with spinal stenosis/radiculopathy",
    test: /spinal stenosis|radiculopathy|low back pain|foraminal|epidural adhesion/i,
  },
];

const NOISE_PATTERN = /nasogastric|NG tube|endo.?tracheal|intubat|central venous|CVC|foley|catheter|tube insertion|port.?a|chest pa|EKG|ECG|echo|ultrasound|sonography|CT|MRI|clipping|成人入院評估|內科病史|外科病史|其他病史|家族病史|過敏史/i;

export function buildDiagnosisContext(patient = {}) {
  const previous = patient.clinicalContext || {};
  const assessment = previous.adultAdmissionAssessment || {};
  const admissionReason = cleanText(assessment.admissionReason || previous.admissionReason?.text || "");
  const assessmentHistory = cleanText(assessment.pastHistory || "");
  const evidence = [];
  const diagnosisMap = new Map();
  const historyMap = new Map();

  addEvidenceFromText({
    text: admissionReason,
    source: "NIS 成人入院評估單：入院原因",
    date: assessment.updatedAt || assessment.capturedAt || "",
    diagnosisMap,
    historyMap,
    evidence,
    primary: true,
  });

  if (admissionReason && !diagnosisMap.size) {
    upsertClinicalItem(diagnosisMap, "admission_reason", {
      key: "admission_reason",
      label: admissionReason,
      text: admissionReason,
      source: "NIS 成人入院評估單：入院原因",
      date: assessment.updatedAt || assessment.capturedAt || "",
      status: "primary",
      confidence: "high",
    });
    addEvidence(evidence, {
      kind: "diagnosis",
      text: clip(admissionReason),
      source: "NIS 成人入院評估單：入院原因",
      date: assessment.updatedAt || assessment.capturedAt || "",
      confidence: "high",
      key: "admission_reason",
    });
  }

  addHistoryFromText({
    text: assessmentHistory,
    source: "NIS 成人入院評估單：過去病史",
    date: assessment.updatedAt || assessment.capturedAt || "",
    historyMap,
    evidence,
  });

  addSupplementalRows({
    rows: patient.surgeries || [],
    source: "手術紀錄",
    textOf: (row) => [row.procedure, row.operation, row.diagPre, row.diagPost, row.indication, row.finding, row.note].filter(Boolean).join(" "),
    dateOf: (row) => row.date || row.start || "",
    diagnosisMap,
    historyMap,
    evidence,
    patient,
  });

  addSupplementalRows({
    rows: patient.pathology || [],
    source: "病理報告",
    textOf: (row) => [row.type, row.specimen, row.diagnosis, row.report].filter(Boolean).join(" "),
    dateOf: (row) => row.date || "",
    diagnosisMap,
    historyMap,
    evidence,
    patient,
  });

  addSupplementalRows({
    rows: patient.imaging || [],
    source: "影像/檢查報告",
    textOf: (row) => [row.type, row.impression, row.report].filter(Boolean).join(" "),
    dateOf: (row) => row.date || "",
    diagnosisMap,
    historyMap,
    evidence,
    patient,
  });

  finalizeDiagnosisMaps({ diagnosisMap, historyMap, patient });

  const currentDiagnoses = [...diagnosisMap.values()];
  const diagnosisKeys = new Set(currentDiagnoses.map((item) => item.key));
  const pastHistory = [...historyMap.values()].filter((item) => !diagnosisKeys.has(item.key));
  const aiIntegrated = {
    mode: "adult_assessment_admission_reason_primary",
    explicitDiagnoses: currentDiagnoses,
    importantHistory: pastHistory,
    evidence,
  };

  return {
    ...previous,
    currentDiagnoses,
    pastHistory,
    admissionReason: admissionReason ? { source: "NIS 成人入院評估單：入院原因", text: admissionReason } : previous.admissionReason || null,
    adultAdmissionAssessment: assessment || previous.adultAdmissionAssessment || null,
    sourceExtracts: previous.sourceExtracts || [],
    aiIntegrated,
  };
}

function finalizeDiagnosisMaps({ diagnosisMap, historyMap, patient }) {
  const surgeryCorpus = cleanText((patient.surgeries || [])
    .map((row) => [row.procedure, row.operation, row.diagPre, row.diagPost, row.note].filter(Boolean).join(" "))
    .join(" "));
  if (diagnosisMap.has("anal_fistula") && /fistulectomy/i.test(surgeryCorpus)) {
    const item = diagnosisMap.get("anal_fistula");
    const procedure = /hemorrhoidectomy/i.test(surgeryCorpus)
      ? "s/p Fistulectomy and partial hemorrhoidectomy"
      : "s/p Fistulectomy";
    diagnosisMap.set("anal_fistula", {
      ...item,
      label: item.label.includes("s/p") ? item.label : `${item.label} ${procedure}`,
      text: item.text?.includes("s/p") ? item.text : `${item.text || item.label} ${procedure}`,
    });
    diagnosisMap.delete("hemorrhoid");
    historyMap.delete("hemorrhoid");
  }
}

function addEvidenceFromText({ text, source, date, diagnosisMap, historyMap, evidence, primary = false }) {
  if (!text) return;
  const chunks = splitClinicalText(text);
  for (const chunk of chunks) {
    addDiagnosisCandidates({ text: chunk, source, date, diagnosisMap, evidence, primary });
    addHistoryCandidates({ text: chunk, source, date, historyMap, evidence, primary });
  }
}

function addHistoryFromText({ text, source, date, historyMap, evidence }) {
  if (!text || isNegativeHistoryText(text)) return;
  for (const chunk of splitClinicalText(text)) {
    addHistoryCandidates({ text: chunk, source, date, historyMap, evidence, primary: true });
  }
}

function addSupplementalRows({ rows, source, textOf, dateOf, diagnosisMap, historyMap, evidence, patient }) {
  for (const row of rows.slice(0, 30)) {
    const text = cleanText(textOf(row));
    if (!text) continue;
    const date = dateOf(row);
    if (!diagnosisMap.size || isSameAdmissionEvidence(date, patient)) {
      addDiagnosisCandidates({ text, source, date, diagnosisMap, evidence, primary: false });
    }
    addHistoryCandidates({ text, source, date, historyMap, evidence, primary: false });
  }
}

function isSameAdmissionEvidence(date, patient = {}) {
  const admissionStart = patient.admissionPeriod?.startDate || patient.admissionDate || "";
  if (!date || !admissionStart) return false;
  const evidenceDate = parseClinicalDate(date);
  const startDate = parseClinicalDate(admissionStart);
  if (!evidenceDate || !startDate) return false;
  const dayMs = 24 * 60 * 60 * 1000;
  return evidenceDate.getTime() >= startDate.getTime() - dayMs;
}

function parseClinicalDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDiagnosisCandidates({ text, source, date, diagnosisMap, evidence, primary }) {
  for (const rule of DIAGNOSIS_RULES) {
    if (!rule.test.test(text)) continue;
    if (!primary && isPureProcedureNoise(text) && !/adenocarcinoma|carcinoma|malignan|cancer|癌/i.test(text)) continue;
    const procedure = procedurePhrase(rule, text);
    const label = procedure ? `${rule.label} ${procedure}` : rule.label;
    upsertClinicalItem(diagnosisMap, rule.key, {
      key: rule.key,
      label,
      text: label,
      source,
      date,
      status: primary ? "明確" : "補充",
      confidence: primary ? "high" : "medium",
    });
    addEvidence(evidence, { kind: "診斷", text: clip(text), source, date, confidence: primary ? "high" : "medium", key: rule.key });
  }
}

function addHistoryCandidates({ text, source, date, historyMap, evidence, primary }) {
  if (isNegativeHistoryText(text)) return;
  for (const rule of HISTORY_RULES) {
    if (!rule.test.test(text)) continue;
    const procedure = procedurePhrase(rule, text);
    const label = procedure ? `${rule.label} ${procedure}` : rule.label;
    upsertClinicalItem(historyMap, rule.key, {
      key: rule.key,
      label,
      text: label,
      source,
      date,
      status: primary ? "明確" : "補充",
      confidence: primary ? "high" : "medium",
    });
    addEvidence(evidence, { kind: "過去病史", text: clip(text), source, date, confidence: primary ? "high" : "medium", key: rule.key });
  }
}

function procedurePhrase(rule, text) {
  if (!rule.procedure || !rule.procedure.test(text)) return "";
  if (/fistulectomy/i.test(text) && /hemorrhoidectomy/i.test(text)) return "s/p Fistulectomy and partial hemorrhoidectomy";
  if (/CO2 laser turbinectomy/i.test(text)) return "s/p CO2 laser turbinectomy";
  if (/low anterior resection|LAR/i.test(text)) return "s/p LAR";
  return rule.procedureText || "";
}

function upsertClinicalItem(map, key, item) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, item);
    return;
  }
  if (!existing.label.includes("s/p") && item.label.includes("s/p")) {
    map.set(key, {
      ...existing,
      label: mergeProcedureLabel(existing.label, item.label),
      text: mergeProcedureLabel(existing.text || existing.label, item.label),
    });
    return;
  }
  const existingScore = confidenceScore(existing);
  const nextScore = confidenceScore(item);
  if (nextScore > existingScore || (nextScore === existingScore && item.label.length > existing.label.length)) {
    map.set(key, { ...existing, ...item });
  }
}

function mergeProcedureLabel(baseLabel, procedureLabel) {
  const procedure = String(procedureLabel || "").match(/\bs\/p\b.+$/i)?.[0] || "";
  if (!procedure) return baseLabel;
  return `${baseLabel} ${procedure}`.replace(/\s+/g, " ").trim();
}

function confidenceScore(item) {
  return (item.status === "明確" ? 4 : 2) + (item.label?.includes("s/p") ? 1 : 0);
}

function addEvidence(evidence, item) {
  const key = [item.kind, item.key, item.source, item.date].join("|");
  if (evidence.some((row) => [row.kind, row.key, row.source, row.date].join("|") === key)) return;
  evidence.push(item);
}

function splitClinicalText(text) {
  return cleanText(text)
    .split(/\n|；|;|。|、|\u2022|(?=\d+\.)/)
    .map((item) => item.replace(/^[\s:：,，.-]+/, "").trim())
    .filter(Boolean);
}

function isPureProcedureNoise(text) {
  const value = cleanText(text);
  return NOISE_PATTERN.test(value) && !DIAGNOSIS_RULES.some((rule) => rule.test.test(value));
}

function isNegativeHistoryText(text) {
  const value = cleanText(text);
  return /無\s*不詳\s*有|無\s*有|無\s*$|nil|denied|no remarkable|none/i.test(value) && value.length < 60;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clip(text) {
  const value = cleanText(text);
  return value.length > 220 ? `${value.slice(0, 220)}...` : value;
}
