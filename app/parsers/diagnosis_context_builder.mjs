import { selectNursingAdmissionAssessment } from "./nursing_care_record_parser.mjs";

const DIAGNOSIS_RULES = [
  {
    key: "suspected_colorectal_malignancy",
    label: "Suspected colorectal malignancy",
    // NIS adult assessment commonly combines location, uncertainty, and
    // malignancy in one comma-connected narrative.
    test: /(?:colon|colorectal|cecal|sigmoid|rectal|\u5927\u8178|\u7d50\u8178|\u76f2\u8178|\u76f4\u8178)[\s\S]{0,120}(?:suspect(?:ed|ion)?|possible|\u61f7\u7591|\u7591\u4f3c)[\s\S]{0,80}(?:malignan(?:cy|t)?|cancer|tumou?r|\u60e1\u6027\u816b\u7624|\u764c)/i,
    suspected: true,
  },
  {
    key: "suspected_colorectal_malignancy",
    label: "Suspected colorectal malignancy",
    // This is deliberately limited to a colon/cecum context plus uncertainty.
    // It preserves the admission assessment's wording instead of asserting a
    // confirmed cancer diagnosis before pathology or a clinician note does.
    test: /(?:盲腸|大腸|結腸|colon|cecal)[\s\S]{0,100}(?:懷疑|疑似)[\s\S]{0,50}(?:惡性腫瘤|癌|malignan|cancer)/i,
    suspected: true,
  },
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
  addDirectHistory({
    text: assessmentHistory,
    source: "NIS 成人入院評估單：過去病史",
    date: assessment.updatedAt || assessment.capturedAt || "",
    historyMap,
    evidence,
  });

  const nursingAdmissionAssessment = selectNursingAdmissionAssessment(patient.nursing || []);
  if (nursingAdmissionAssessment?.pastHistory) {
    addHistoryFromText({
      text: nursingAdmissionAssessment.pastHistory,
      source: nursingAdmissionAssessment.source,
      date: nursingAdmissionAssessment.time,
      historyMap,
      evidence,
    });
    addDirectHistory({
      text: nursingAdmissionAssessment.pastHistory,
      source: nursingAdmissionAssessment.source,
      date: nursingAdmissionAssessment.time,
      historyMap,
      evidence,
    });
  }

  // Onepage's admission summary and latest progress note are the clinician
  // authored source of truth for this admission.  They supplement NIS rather
  // than being inferred from orders, imaging, or procedures.
  const noteSession = previous.noteSession || {};
  const admissionNote = noteSession.admission;
  const progressNotes = Array.isArray(noteSession.progress) ? noteSession.progress : [];
  const dischargeNote = noteSession.discharge;
  addEvidenceFromText({
    text: cleanText(admissionNote?.content || ""),
    source: "Onepage 入院病摘",
    date: admissionNote?.date || "",
    diagnosisMap,
    historyMap,
    evidence,
    primary: true,
  });
  for (const note of progressNotes.slice(0, 3)) {
    addEvidenceFromText({
      text: cleanText(note?.content || ""),
      source: "Onepage Progress",
      date: note?.date || "",
      diagnosisMap,
      historyMap,
      evidence,
      primary: true,
    });
  }
  addHistoryFromText({
    text: cleanText(dischargeNote?.content || ""),
    source: "Onepage 出院病摘",
    date: dischargeNote?.date || "",
    historyMap,
    evidence,
  });

  // Imaging and pathology payloads can be returned with a valid
  // patient/admission envelope while their report body is stale or belongs to
  // another patient. They remain fully visible in their source tabs for human
  // review, but must never independently create a diagnosis or past history.
  // Only patient-authored/clinician-authored primary sources above may do so.
  // The exception is a structured, episode-classified surgery post-operative
  // diagnosis. It may only cross-support an already established current
  // diagnosis, or become past history when it is verified as a prior episode.
  const surgicalDiagnosisEvidence = applySurgeryPostoperativeDiagnoses({
    surgeries: patient.surgeries || [],
    diagnosisMap,
    historyMap,
    evidence,
  });

  finalizeDiagnosisMaps({ diagnosisMap, historyMap, patient });

  const currentDiagnoses = [...diagnosisMap.values()];
  const diagnosisKeys = new Set(currentDiagnoses.map((item) => item.key));
  const pastHistory = [...historyMap.values()].filter((item) => !diagnosisKeys.has(item.key) || String(item.key || "").startsWith("history_text:"));
  const aiIntegrated = {
    mode: "onepage_note_and_adult_assessment_primary",
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
    nursingAdmissionAssessment,
    sourceExtracts: previous.sourceExtracts || [],
    surgicalDiagnosisEvidence,
    aiIntegrated,
  };
}

function finalizeDiagnosisMaps({ diagnosisMap, historyMap, patient }) {
  const surgeryCorpus = cleanText((patient.surgeries || [])
    .filter((row) => row.admissionScope === "current")
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

function applySurgeryPostoperativeDiagnoses({ surgeries, diagnosisMap, historyMap, evidence }) {
  const results = [];
  for (const row of surgeries.slice(0, 30)) {
    const diagnosis = cleanText(row.diagPost || row.diagPre || "");
    if (!diagnosis) continue;
    const procedure = cleanText(row.procedure || row.operation || "");
    const date = cleanText(row.date || "");
    const scope = row.admissionScope;
    const base = {
      diagnosis,
      procedure,
      date,
      admissionScope: scope || "unverified",
      admissionEvidence: row.admissionEvidence || "",
      source: "Onepage 手術術後診斷",
    };

    if (scope === "current") {
      const supportedKeys = [...diagnosisMap.values()]
        .filter((item) => surgerySupportsDiagnosis(diagnosis, item.key))
        .map((item) => item.key);
      for (const key of supportedKeys) {
        const item = diagnosisMap.get(key);
        const support = ["手術術後診斷支持", procedure && `手術：${procedure}`].filter(Boolean).join("；");
        diagnosisMap.set(key, {
          ...item,
          source: item.source.includes("手術術後診斷支持") ? item.source : `${item.source}；${support}`,
          supportingEvidence: dedupeStrings([...(item.supportingEvidence || []), `${diagnosis}${procedure ? ` · ${procedure}` : ""}`]),
        });
        addEvidence(evidence, {
          kind: "surgical_support",
          text: clip(`${diagnosis}${procedure ? ` · ${procedure}` : ""}`),
          source: "Onepage 手術術後診斷（同次住院）",
          date,
          confidence: "medium",
          key,
        });
      }
      results.push({ ...base, effect: supportedKeys.length ? "current_support" : "review_only", supports: supportedKeys });
      continue;
    }

    if (scope === "history") {
      const key = `postop_history:${normalizeKey(diagnosis)}:${normalizeKey(procedure || date)}`;
      const label = [diagnosis, procedure && `s/p ${procedure}`, date && `on ${date}`].filter(Boolean).join(" ");
      upsertClinicalItem(historyMap, key, {
        key,
        label,
        text: label,
        source: "Onepage 手術術後診斷（既往住院）",
        date,
        status: "history",
        confidence: "medium",
      });
      addEvidence(evidence, { kind: "past_history", text: clip(label), source: "Onepage 手術術後診斷（既往住院）", date, confidence: "medium", key });
      results.push({ ...base, effect: "past_history", supports: [] });
      continue;
    }

    // Unverified surgery rows are visible in the surgery tab only. They do
    // not change current diagnoses or history.
    results.push({ ...base, effect: "review_only", supports: [] });
  }
  return results;
}

function surgerySupportsDiagnosis(postoperativeDiagnosis, key) {
  const text = cleanText(postoperativeDiagnosis).toLowerCase();
  if (key === "suspected_colorectal_malignancy" || key === "colorectal_cancer") {
    return /colon|colorectal|cecal|sigmoid|rectal|rectum|結腸|大腸|盲腸|直腸/.test(text)
      && /tumou?r|mass|neoplasm|malignan|cancer|癌|腫瘤/.test(text);
  }
  return false;
}

function normalizeKey(value) {
  return cleanText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "unspecified";
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
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

function addDirectHistory({ text, source, date, historyMap, evidence }) {
  const value = cleanText(text);
  if (!value || isNegativeHistoryText(value)) return;
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (!normalized) return;
  const duplicate = [...historyMap.values()].some((item) => {
    const prior = cleanText(item.text || item.label).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    return prior && (prior === normalized || prior.includes(normalized) || normalized.includes(prior));
  });
  if (!duplicate) {
    upsertClinicalItem(historyMap, `history_text:${normalized.slice(0, 120)}`, {
      key: `history_text:${normalized.slice(0, 120)}`,
      label: value,
      text: value,
      source,
      date,
      status: "primary",
      confidence: "high",
    });
  }
  addEvidence(evidence, { kind: "past_history", text: clip(value), source, date, confidence: "high", key: `history_text:${normalized.slice(0, 120)}` });
}

function addSupplementalRows({ rows, source, textOf, dateOf, diagnosisMap, historyMap, evidence, patient, allowHistorical = true }) {
  for (const row of rows.slice(0, 30)) {
    const text = cleanText(textOf(row));
    if (!text) continue;
    const date = dateOf(row);
    if (row.admissionScope === "current") {
      addDiagnosisCandidates({ text, source, date, diagnosisMap, evidence, primary: false });
      addHistoryCandidates({ text, source, date, historyMap, evidence, primary: false });
    } else if (allowHistorical && row.admissionScope === "history") {
      addHistoricalDiagnosisCandidates({ text, source, date, historyMap, evidence });
      addHistoryCandidates({ text, source, date, historyMap, evidence, primary: false });
    }
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
  const match = text.match(/(\d{3,4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return null;
  let year = Number(match[1]);
  if (year >= 100 && year < 300) year += 1911;
  const date = new Date(year, Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDiagnosisCandidates({ text, source, date, diagnosisMap, evidence, primary }) {
  for (const rule of DIAGNOSIS_RULES) {
    if (!rule.test.test(text)) continue;
    if (!primary && isPureProcedureNoise(text) && !/adenocarcinoma|carcinoma|malignan|cancer|癌/i.test(text)) continue;
    const procedure = procedurePhrase(rule, text);
    const label = procedure ? `${rule.label} ${procedure}` : rule.label;
    const suspected = rule.suspected === true;
    upsertClinicalItem(diagnosisMap, rule.key, {
      key: rule.key,
      label,
      text: label,
      source,
      date,
      status: suspected ? "疑似" : (primary ? "明確" : "補充"),
      confidence: suspected ? "medium" : (primary ? "high" : "medium"),
    });
    addEvidence(evidence, { kind: "診斷", text: clip(text), source, date, confidence: suspected ? "medium" : (primary ? "high" : "medium"), key: rule.key });
  }
}

function addHistoricalDiagnosisCandidates({ text, source, date, historyMap, evidence }) {
  for (const rule of DIAGNOSIS_RULES) {
    if (!rule.test.test(text)) continue;
    if (isPureProcedureNoise(text) && !/adenocarcinoma|carcinoma|malignan|cancer|癌/i.test(text)) continue;
    const procedure = procedurePhrase(rule, text);
    const label = procedure ? `${rule.label} ${procedure}` : rule.label;
    upsertClinicalItem(historyMap, rule.key, {
      key: rule.key,
      label,
      text: label,
      source,
      date,
      status: "history",
      confidence: "medium",
    });
    addEvidence(evidence, { kind: "past_history", text: clip(text), source, date, confidence: "medium", key: rule.key });
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
    // Keep comma-connected admission narratives intact. Important clinical
    // context such as "cecal lesion ... suspected malignancy" is often split
    // across Chinese commas rather than full sentence boundaries.
    .split(/\n|；|;|。|\u2022/)
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
