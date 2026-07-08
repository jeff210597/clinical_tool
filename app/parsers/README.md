# Onepage / NIS Parser 介面規格

此目錄先定義 parser 的輸入輸出契約。第一版 Web 工作台已可承接這些結構；後續只要把 stub 換成實際 Onepage/NIS 讀取即可。

## 診斷病史資料來源

必須整合下列來源：

```text
住院醫囑
入院病摘
Progress
出院病摘
護理查詢 > 成人入院評估單
```

## Adult Admission Assessment Parser

用途：

- 擷取住院原因。
- 擷取過去病史。
- 擷取成人入院護理評估摘要。

入口流程：

```text
Onepage /{patient}/story
  -> 找目前住院 episode: .sess.ipd 第一筆或標示住院中的 episode
  -> 點擊 護理查詢
  -> 進入 NIS/HISVIEW/hview_index?feeno={id}&userid={id}
  -> 點擊 成人入院評估單
  -> 擷取成人入院評估單內容
```

目前已確認：

- `護理查詢` 會導向 NIS/HISVIEW frameset。
- 功能列為 `HView_Function?feeno={feeno}`。
- `成人入院評估單` onclick 為 `openurl('../AdmissionAssessment/AssessmentAdult_PDF?feeno=','FeeNo','right')`。
- 實作可直接呼叫 `http://10.125.254.46/NIS/AdmissionAssessment/AssessmentAdult_PDF?feeno={feeno}`。

已實作：

```text
adult_assessment_parser.mjs
```

輸出格式：

```json
{
  "source": "護理查詢 > 成人入院評估單",
  "status": "ok",
  "capturedAt": "2026-07-06T12:00:00+08:00",
  "admissionReason": "...",
  "pastHistory": "...",
  "functionalAssessment": "...",
  "rawSourceRef": "optional-local-redacted-ref"
}
```

## Diagnosis Context Parser

輸出格式：

```json
{
  "currentDiagnoses": [
    {"source": "住院醫囑", "text": "..."},
    {"source": "Progress", "text": "..."}
  ],
  "pastHistory": [
    {"source": "成人入院評估單", "text": "..."},
    {"source": "出院病摘", "text": "..."}
  ],
  "admissionReason": {
    "source": "成人入院評估單 / 入院病摘",
    "text": "..."
  },
  "sourceExtracts": [
    {
      "key": "adult_assessment",
      "source": "成人入院評估單",
      "status": "ok",
      "fields": ["入院原因", "過去病史", "功能/護理評估"],
      "lastResult": "..."
    }
  ]
}
```

## AI 判讀輸入

AI 不直接讀 raw HTML，必須使用結構化資料：

```json
{
  "profile": {"chartNo": "...", "bedNo": "..."},
  "diagnosisContext": {},
  "vitals": [],
  "labs": [],
  "intakeOutput": {},
  "imaging": [],
  "surgeries": [],
  "orders": []
}
```

## AI 判讀限制

- 預設 rule-based。
- 外部 LLM 預設關閉。
- 若院方未核准，不得把可識別病歷送到外部 API。
- AI 只產生問題整理與查房提醒，不產生醫囑。
