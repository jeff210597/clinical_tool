const LAB_FOCUS = [
  { key: "WBC", pattern: /\bWBC\b/i, system: "infection" },
  { key: "Neutrophil", pattern: /neutrophil/i, system: "infection" },
  { key: "Lymphocyte", pattern: /lymphocyte/i, system: "infection" },
  { key: "CRP", pattern: /\bCRP\b/i, system: "infection" },
  { key: "HGB", pattern: /\bHGB|hemoglobin/i, system: "anemia" },
  { key: "HCT", pattern: /\bHCT|hematocrit/i, system: "anemia" },
  { key: "Platelet", pattern: /platelet|\bPLT\b/i, system: "platelet" },
  { key: "BUN", pattern: /\bBUN\b|urea/i, system: "renal" },
  { key: "Creatinine", pattern: /creatinine|\bCr\b/i, system: "renal" },
  { key: "eGFR", pattern: /eGFR/i, system: "renal" },
  { key: "Na", pattern: /\bNa\b|sodium/i, system: "electrolyte" },
  { key: "K", pattern: /\bK\b|potassium/i, system: "electrolyte" },
  { key: "Glucose", pattern: /glucose|sugar/i, system: "glucose" },
];

export function buildRuleBasedAssessment(patient) {
  const labTrends = buildLabTrends(patient?.labs || []);
  const clinicalSignals = inferClinicalSignals(labTrends, patient);
  const priorities = clinicalSignals.length
    ? clinicalSignals
    : ["目前 lab 趨勢訊號不足；請補齊最近兩次以上抽血、TPR、I/O 與影像後再判讀。"];

  if (patient?.orders?.length) {
    priorities.push(`醫囑共 ${patient.orders.length} 筆：請對照 active/DC/STAT、抗生素、輸液、檢驗與影像醫囑是否符合目前變化。`);
  }

  return {
    mode: "rule-based-lab-trends",
    generatedAt: new Date().toISOString(),
    summary: "依已擷取抽血趨勢、TPR/I-O 與影像文字產生的病情變化提示；正式判讀仍需回原始病歷核對。",
    labTrends,
    priorities,
    cautions: [
      "趨勢判讀只使用工作台已擷取資料；缺資料不可視為正常。",
      "紅藍高低值依來源 flag 或參考區間推估，必要時請回 Onepage lab 原表確認。",
    ],
  };
}

function buildLabTrends(labs) {
  const rows = [];
  for (const focus of LAB_FOCUS) {
    const matches = labs
      .filter((row) => focus.pattern.test(row.item || ""))
      .sort((a, b) => parseTime(b.time) - parseTime(a.time));
    if (!matches.length) continue;
    const latest = matches[0];
    const previous = matches[1] || {};
    const latestValue = numericValue(latest.latest);
    const previousValue = numericValue(previous.latest);
    rows.push({
      item: latest.item || focus.key,
      system: focus.system,
      latest: latest.latest || "",
      previous: previous.latest || latest.previous || "",
      unit: latest.unit || "",
      ref: latest.ref || "",
      time: latest.time || "",
      flag: normalizeFlag(latest),
      direction: inferDirection(latestValue, previousValue, latest.trend),
      delta: Number.isFinite(latestValue) && Number.isFinite(previousValue) ? round(latestValue - previousValue) : "",
    });
  }
  return rows;
}

function inferClinicalSignals(trends, patient) {
  const signals = [];
  const bySystem = new Map();
  for (const row of trends) {
    if (!bySystem.has(row.system)) bySystem.set(row.system, []);
    bySystem.get(row.system).push(row);
  }

  const infection = bySystem.get("infection") || [];
  if (infection.some((row) => row.flag === "high" || row.direction === "up")) {
    signals.push("感染/發炎指標可能上升：WBC/Neutrophil/CRP 若持續上升，需對照發燒、血壓、影像與抗生素反應。");
  } else if (infection.some((row) => row.direction === "down")) {
    signals.push("感染/發炎指標有下降訊號：若生命徵象穩定，可能代表治療反應改善。");
  }

  const anemia = bySystem.get("anemia") || [];
  if (anemia.some((row) => row.flag === "low" || row.direction === "down")) {
    signals.push("貧血或失血風險需追蹤：HGB/HCT 偏低或下降時，請對照術後狀態、出血、輸血與引流量。");
  }

  const renal = bySystem.get("renal") || [];
  if (renal.some((row) => (row.item || "").match(/creatinine|BUN/i) && (row.flag === "high" || row.direction === "up"))) {
    signals.push("腎功能/脫水或 AKI 風險：BUN/Cr 上升時，需結合 I/O balance、尿量、輸液與 nephrotoxic drugs。");
  }

  const electrolytes = bySystem.get("electrolyte") || [];
  if (electrolytes.some((row) => row.flag)) {
    signals.push("電解質異常需處理：Na/K 高低值請對照補液、利尿劑、腎功能與心電圖風險。");
  }

  const platelet = bySystem.get("platelet") || [];
  if (platelet.some((row) => row.flag === "low" || row.direction === "down")) {
    signals.push("血小板偏低或下降：需評估感染、藥物、出血風險與是否需延伸凝血檢查。");
  }

  const imagingText = (patient?.imaging || []).map((row) => `${row.type || ""} ${row.impression || row.report || ""}`).join("\n");
  if (/opacity|infiltrate|pneumonia|effusion|blunting|atelectasis/i.test(imagingText)) {
    signals.push("影像有肺部變化線索：請把胸片/CT 報告與 SpO2、呼吸音、痰量及感染指標一起判讀。");
  }

  return signals;
}

function inferDirection(latest, previous, trend) {
  const trendText = String(trend || "").toLowerCase();
  if (/up|rise|increas|↑/.test(trendText)) return "up";
  if (/down|fall|decreas|↓/.test(trendText)) return "down";
  if (!Number.isFinite(latest) || !Number.isFinite(previous)) return "";
  const diff = latest - previous;
  if (Math.abs(diff) < Math.max(Math.abs(previous) * 0.05, 0.1)) return "flat";
  return diff > 0 ? "up" : "down";
}

function normalizeFlag(row = {}) {
  const flag = String(row.flag || "").trim().toLowerCase();
  if (/^(h|hi|high|\+|↑|red)$/.test(flag) || /\bh\b|high|↑/.test(flag)) return "high";
  if (/^(l|lo|low|↓|blue)$/.test(flag) || /\bl\b|low|↓/.test(flag)) return "low";
  return "";
}

function numericValue(value) {
  const num = Number.parseFloat(String(value || "").replace(/,/g, ""));
  return Number.isFinite(num) ? num : NaN;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function parseTime(value) {
  const time = new Date(String(value || "").replace(/\//g, "-")).getTime();
  return Number.isNaN(time) ? 0 : time;
}
