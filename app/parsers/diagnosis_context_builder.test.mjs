import assert from "node:assert/strict";
import { buildDiagnosisContext } from "./diagnosis_context_builder.mjs";

function patientWith(rows) {
  return {
    admissionPeriod: { startDate: "2026/07/14", status: "inpatient" },
    clinicalContext: {},
    imaging: rows,
  };
}

const historical = buildDiagnosisContext(patientWith([
  { date: "2024/04/08", impression: "Rectal cancer s/p LAR", admissionScope: "history" },
]));
assert.equal(historical.currentDiagnoses.length, 0, "historical imaging must not become a current diagnosis");
assert.equal(historical.pastHistory.filter((item) => item.key === "colorectal_cancer").length, 0, "historical imaging must not independently become past-history evidence");

const unverifiedHistorical = buildDiagnosisContext(patientWith([
  { date: "2024/04/08", impression: "Rectal cancer s/p LAR", admissionScope: "unverified" },
]));
assert.equal(unverifiedHistorical.pastHistory.filter((item) => item.key === "colorectal_cancer").length, 0, "unscoped imaging must not become past-history evidence");

const current = buildDiagnosisContext(patientWith([
  { date: "2026/07/15", impression: "Rectal cancer s/p LAR", admissionScope: "current" },
]));
assert.equal(current.currentDiagnoses.filter((item) => item.key === "colorectal_cancer").length, 0, "even current-admission imaging must never independently create a diagnosis");
assert.equal(current.pastHistory.filter((item) => item.key === "colorectal_cancer").length, 0);

const bilingual = buildDiagnosisContext({
  admissionPeriod: { startDate: "2026/07/14", status: "inpatient" },
  clinicalContext: { noteSession: { progress: [{ date: "2026/07/15", content: "Rectal cancer / colorectal adenocarcinoma" }] } },
});
assert.equal(bilingual.currentDiagnoses.filter((item) => item.key === "colorectal_cancer").length, 1, "known bilingual aliases must collapse to one English diagnosis");

const suspectedColon = buildDiagnosisContext({
  admissionPeriod: { startDate: "2026/07/14", status: "inpatient" },
  clinicalContext: { adultAdmissionAssessment: { admissionReason: "長期便祕，盲腸息肉切除後懷疑是惡性腫瘤，建議入院詳檢。" } },
});
const suspectedItem = suspectedColon.currentDiagnoses.find((item) => item.key === "suspected_colorectal_malignancy");
assert.equal(suspectedItem?.label, "Suspected colorectal malignancy");
assert.equal(suspectedItem?.status, "疑似");

const nursingHistory = buildDiagnosisContext({
  admissionPeriod: { startDate: "2026/07/10", status: "inpatient" },
  clinicalContext: {},
  nursing: [
    { time: "2026/07/10 10:31", note: "I：提供衛教指導。", author: "Nurse" },
    { time: "2026/07/10 10:30", note: "Admitted at 10:30。S：病人入院。外科病史：20年前曾接受膽囊切除術；過敏史：否認藥物過敏。I：安排病房環境介紹。", author: "Nurse" },
  ],
});
assert.equal(nursingHistory.nursingAdmissionAssessment?.time, "2026/07/10 10:30");
assert.match(nursingHistory.nursingAdmissionAssessment?.pastHistory || "", /外科病史/);
assert.ok(nursingHistory.pastHistory.some((item) => item.source === "NIS 護理入院評估"), "nursing admission history must be visible in past history");

const nursingCourse = buildDiagnosisContext({
  admissionPeriod: { startDate: "2026/07/12", status: "inpatient" },
  clinicalContext: {},
  nursing: [
    { time: "2026/07/12 09:52", note: "Admitted at 09:52\n一般：病人於115/03/07行切片，病理報告腺癌，已行化療6次及電療25次。6/17追蹤 CT，經評估後入院治療。", author: "Nurse" },
  ],
});
assert.equal(nursingCourse.nursingAdmissionAssessment?.historyKind, "historical_course");
assert.ok(nursingCourse.pastHistory.some((item) => item.source === "NIS 護理入院評估：既往病程"), "prior treatment timeline must remain visible as history");

const unverifiedSurgeryHistory = buildDiagnosisContext({
  admissionPeriod: { startDate: "2026/07/14", status: "inpatient" },
  clinicalContext: {},
  surgeries: [{ date: "2021/12/17", procedure: "Rectal cancer surgery", admissionScope: "unverified" }],
});
assert.equal(unverifiedSurgeryHistory.pastHistory.some((item) => item.key === "colorectal_cancer"), false, "unverified surgery cannot create past history");

const currentSurgerySupport = buildDiagnosisContext({
  admissionPeriod: { startDate: "2026/07/12", status: "inpatient" },
  clinicalContext: { adultAdmissionAssessment: { admissionReason: "colon lesion, suspected malignancy" } },
  surgeries: [{
    date: "2026/07/15",
    procedure: "Laparoscopic Right Hemicolectomy",
    diagPost: "Colon tumor",
    admissionScope: "current",
    admissionEvidence: "date_in_current_admission",
  }],
});
const currentSupportedDiagnosis = currentSurgerySupport.currentDiagnoses.find((item) => item.key === "suspected_colorectal_malignancy");
assert.equal(currentSupportedDiagnosis?.status, "疑似", "postoperative diagnosis must not upgrade a suspected malignancy to confirmed cancer");
assert.match(currentSupportedDiagnosis?.source || "", /手術術後診斷支持/, "current operation may cross-support an already established diagnosis");
assert.equal(currentSurgerySupport.pastHistory.some((item) => item.key.startsWith("postop_history:")), false, "current-admission operation must not become past history");
assert.equal(currentSurgerySupport.surgicalDiagnosisEvidence[0]?.effect, "current_support");

const priorSurgeryHistory = buildDiagnosisContext({
  admissionPeriod: { startDate: "2026/07/12", status: "inpatient" },
  clinicalContext: {},
  surgeries: [{
    date: "2025/07/15",
    procedure: "Laparoscopic Right Hemicolectomy",
    diagPost: "Colon tumor",
    admissionScope: "history",
    admissionEvidence: "date_before_current_admission",
  }],
});
assert.equal(priorSurgeryHistory.currentDiagnoses.length, 0, "prior operation must not create a current diagnosis");
assert.match(priorSurgeryHistory.pastHistory.find((item) => item.key.startsWith("postop_history:"))?.label || "", /Colon tumor s\/p Laparoscopic Right Hemicolectomy on 2025\/07\/15/);
assert.equal(priorSurgeryHistory.surgicalDiagnosisEvidence[0]?.effect, "past_history");
