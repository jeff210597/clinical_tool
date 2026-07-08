import { fetchAdultAdmissionAssessment } from "./adult_assessment_parser.mjs";

const feeno = process.argv[2];
if (!feeno) {
  console.error("usage: node test_adult_assessment_redacted.mjs <feeno>");
  process.exit(1);
}

const result = await fetchAdultAdmissionAssessment({ feeno });
const interestingKeys = Object.keys(result.fields).filter((key) =>
  /入院|病史|過敏|活動|意識|解尿|大便|照顧|特殊/.test(key)
);

console.log(JSON.stringify({
  status: result.status,
  source: result.source,
  hasAdmissionReason: Boolean(result.admissionReason),
  admissionReasonLength: result.admissionReason.length,
  hasPastHistory: Boolean(result.pastHistory),
  pastHistoryLength: result.pastHistory.length,
  hasFunctionalAssessment: Boolean(result.functionalAssessment),
  functionalAssessmentLength: result.functionalAssessment.length,
  interestingKeys,
}, null, 2));
