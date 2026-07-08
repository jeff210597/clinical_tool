export function parseAdultAdmissionAssessmentStub() {
  return {
    source: "護理查詢 > 成人入院評估單",
    status: "pending_parser",
    capturedAt: null,
    admissionReason: "待接 NIS 成人入院評估單 parser。",
    pastHistory: "待接 NIS 成人入院評估單 parser。",
    functionalAssessment: "待接 NIS 成人入院評估單 parser。",
    rawSourceRef: null,
  };
}

export function buildAdultAssessmentWorkflow() {
  return [
    "開啟 Onepage /{patient}/story",
    "定位目前住院 episode",
    "點擊 護理查詢",
    "在 NIS/HISVIEW 頁點擊 成人入院評估單",
    "擷取入院原因、過去病史、功能/護理評估摘要",
  ];
}
