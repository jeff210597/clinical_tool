import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPatientFromQuery, buildPatientLabHistory } from "../server.mjs";
import { fetchPhysicianInpatients } from "../parsers/onepage_physician_roster.mjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const localDir = join(appDir, ".local");
const sessionStorePath = join(localDir, "sessions.json");
const relayAuditPath = join(localDir, "relay_audit.ndjson");
const relayPatientCache = new Map();
const relayPatientPromises = new Map();
const RELAY_PATIENT_CACHE_TTL_MS = 5 * 60 * 1000;

const LAB_PRIORITY = [
  "WBC",
  "HGB",
  "HCT",
  "Platelet",
  "Neutrophil",
  "Lymphocyte",
  "BUN, Blood Urea Nitrogen",
  "Creatinine(Blood)",
  "eGFR-CKD-EPI",
  "Na, Sodium(Blood)",
  "K, Potassium(Blood)",
  "C-Reactive Protein",
];

export async function getRelayUser() {
  const raw = await readFile(sessionStorePath, "utf8");
  const data = JSON.parse(raw);
  const now = Date.now();
  const candidates = (Array.isArray(data?.sessions) ? data.sessions : [])
    .map((row) => row?.session)
    .filter((session) => session?.onepageAuthToken && Number(session.expiresAt || 0) > now)
    .sort((a, b) => Number(b.onepageLoggedInAt || b.expiresAt || 0) - Number(a.onepageLoggedInAt || a.expiresAt || 0));

  if (!candidates.length) {
    const error = new Error("沒有可用的 Onepage 登入 session。請先在院內主機用工作站登入一次。");
    error.code = "missing_onepage_session";
    throw error;
  }
  return candidates[0];
}

export async function physicianRosterSummary(doctorId, user = null) {
  const relayUser = user || await getRelayUser();
  const roster = await fetchPhysicianInpatients({ doctorId, authToken: relayUser.onepageAuthToken || "" });
  const name = roster.physician?.name ? ` ${roster.physician.name}` : "";
  const lines = [`醫師住院清單｜${roster.physician?.id || doctorId}${name}`, roster.message || ""].filter(Boolean);
  for (const patient of roster.patients || []) {
    const bed = patient.bedNo ? `${patient.bedNo} ` : "";
    const label = [patient.name, patient.chartNo].filter(Boolean).join(" ");
    lines.push(`- ${bed}${label}`.trim());
  }
  await appendRelayAudit({ actor: relayUser.username, action: "ward", doctorId, count: roster.patients?.length || 0, outcome: roster.status });
  return { text: lines.join("\n"), roster };
}

export async function patientRoundingSummary(query, user = null, options = {}) {
  const relayUser = user || await getRelayUser();
  const mode = ["quick", "details"].includes(options.mode) ? options.mode : "full";
  const sources = Array.isArray(options.sources) ? [...new Set(options.sources)].sort() : [];
  const sourceKey = sources.join(",");
  const cacheKey = `${relayUser.username}:${mode}:${sourceKey}:${String(query || "").trim().toLowerCase()}`;
  const cached = relayPatientCache.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() - cached.cachedAt < RELAY_PATIENT_CACHE_TTL_MS) {
    await appendRelayAudit({ actor: relayUser.username, action: "summary_cache", patientRefHash: hashPatientRef(query), outcome: cached.patient.source });
    return { text: formatPatientSummary(cached.patient), patient: { ...cached.patient, cacheStatus: "relay_cache" } };
  }
  const running = relayPatientPromises.get(cacheKey);
  const patient = running || buildPatientFromQuery(query, relayUser, { mode, sources })
    .finally(() => relayPatientPromises.delete(cacheKey));
  if (!running) relayPatientPromises.set(cacheKey, patient);
  const resolvedPatient = await patient;
  relayPatientCache.set(cacheKey, { cachedAt: Date.now(), patient: resolvedPatient });
  if (mode === "full" && !sourceKey) {
    relayPatientCache.set(`${relayUser.username}:quick::${String(query || "").trim().toLowerCase()}`, { cachedAt: Date.now(), patient: resolvedPatient });
    relayPatientCache.set(`${relayUser.username}:details::${String(query || "").trim().toLowerCase()}`, { cachedAt: Date.now(), patient: resolvedPatient });
  }
  await appendRelayAudit({ actor: relayUser.username, action: "summary", patientRefHash: hashPatientRef(query), outcome: resolvedPatient.source });
  return { text: formatPatientSummary(resolvedPatient), patient: resolvedPatient };
}

export async function patientLabHistory(query, options = {}, user = null) {
  const relayUser = user || await getRelayUser();
  const history = await buildPatientLabHistory(query, relayUser, options);
  await appendRelayAudit({ actor: relayUser.username, action: "labs", patientRefHash: hashPatientRef(query), outcome: "ok" });
  return history;
}

export function hashPatientRef(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

async function appendRelayAudit(event) {
  await mkdir(localDir, { recursive: true });
  const safeEvent = {
    at: new Date().toISOString(),
    actor: String(event.actor || ""),
    action: String(event.action || ""),
    doctorId: event.doctorId ? String(event.doctorId) : undefined,
    patientRefHash: event.patientRefHash,
    count: event.count,
    outcome: String(event.outcome || ""),
  };
  await appendFile(relayAuditPath, `${JSON.stringify(safeEvent)}\n`, "utf8");
}

function formatPatientSummary(patient) {
  const header = `${patient.chartNo || patient.patientRef || ""} ${patient.displayName || ""}${patient.bedNo ? `｜${patient.bedNo}` : ""}`.trim();
  const diagnosis = firstText(
    patient.clinicalContext?.aiIntegrated?.explicitDiagnoses?.[0],
    patient.clinicalContext?.currentDiagnoses?.[0]?.text,
    patient.clinicalContext?.admissionReason?.text,
    patient.summary
  );
  const pastHistory = firstText(
    patient.clinicalContext?.aiIntegrated?.pastHistory?.[0],
    patient.clinicalContext?.pastHistory?.[0]?.text
  );
  const admissionReason = firstText(patient.clinicalContext?.admissionReason?.text, patient.clinicalContext?.adultAdmissionAssessment?.admissionReason);

  const lines = [
    `查房摘要｜${header}`,
    patient.message && patient.source !== "nis" ? `狀態：${compact(patient.message, 180)}` : "",
    diagnosis ? `診斷：${compact(diagnosis, 220)}` : "",
    pastHistory ? `過去病史：${compact(pastHistory, 220)}` : "",
    admissionReason ? `入院原因：${compact(admissionReason, 220)}` : "",
    "",
    formatTpr(patient.tpr || patient.vitals || []),
    "",
    formatLabs(patient),
    "",
    formatIntakeOutput(patient.intakeOutput),
    "",
    formatLatestReports("影像", patient.imaging),
    formatLatestReports("手術", patient.surgeries),
    formatLatestReports("病理", patient.pathology),
  ];
  return lines.filter((line) => line !== "").join("\n").trim();
}

function formatTpr(rows) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return "TPR：尚無資料";
  const dates = [];
  const grouped = new Map();
  for (const row of items) {
    const key = tprDateKey(row);
    if (!grouped.has(key)) {
      grouped.set(key, []);
      dates.push(key);
    }
    grouped.get(key).push(row);
  }
  const lines = ["TPR（最近3天）"];
  for (const date of dates.slice(0, 3)) {
    const values = grouped.get(date).slice(0, 4).map((row) => {
      const time = firstText(row.time, row.recordedAt, row.datetime, row.dateTime);
      return compact(`${time} T${valueOf(row, "T", "temperature")} P${valueOf(row, "P", "pulse")} R${valueOf(row, "R", "respiration")} BP${valueOf(row, "BP", "bp")} SpO2${valueOf(row, "SpO2", "spo2")}`, 120);
    });
    lines.push(`- ${date}: ${values.join("；")}`);
  }
  return lines.join("\n");
}

function tprDateKey(row) {
  const text = firstText(row.date, row.time, row.recordedAt, row.datetime, row.dateTime);
  const match = text.match(/(\d{2,4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2})/);
  return match ? match[1] : "未註明日期";
}

function formatLabs(patient) {
  const rows = Array.isArray(patient.labs) ? patient.labs : [];
  if (!rows.length) return "Labs：尚無資料";

  const timeKey = (row) => firstText(row.time, row.datetime, row.dateTime, row.collectedAt, row.reportedAt, row.latestTime, row.date) || "最新";
  const grouped = new Map();
  for (const row of rows) {
    const key = timeKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const lines = ["Labs（最近3次抽血）"];
  for (const [time, values] of Array.from(grouped.entries()).slice(0, 3)) {
    const selected = selectLabItems(values).map((row) => `${row.item || row.name}: ${labValue(row)}`).join("；");
    lines.push(`- ${time}: ${compact(selected || "無重點項目", 360)}`);
  }
  return lines.join("\n");
}

function selectLabItems(values) {
  const byName = new Map();
  for (const row of values) {
    const name = String(row.item || row.name || "").trim();
    if (name && !byName.has(name)) byName.set(name, row);
  }
  const picked = [];
  for (const name of LAB_PRIORITY) {
    if (byName.has(name)) picked.push(byName.get(name));
  }
  return picked.length ? picked : values.slice(0, 10);
}

function labValue(row) {
  const value = firstText(row.value, row.latest, row.result, row.text);
  const flag = firstText(row.flag, row.abnormalFlag);
  const unit = firstText(row.unit);
  return [value, flag, unit].filter(Boolean).join(" ");
}

function formatIntakeOutput(intakeOutput) {
  if (!intakeOutput || (!intakeOutput.totals && !intakeOutput.input?.length && !intakeOutput.output?.length)) return "I/O：尚無資料";
  const totals = intakeOutput.totals || {};
  const period = firstText(intakeOutput.period, intakeOutput.date);
  const pieces = [
    period,
    totals.input ? `入 ${totals.input}` : "",
    totals.output ? `出 ${totals.output}` : "",
    totals.balance ? `平衡 ${totals.balance}` : "",
  ].filter(Boolean);
  return `I/O：${pieces.length ? pieces.join("，") : "尚無總量"}`;
}

function formatLatestReports(label, reports) {
  const first = Array.isArray(reports) ? reports[0] : null;
  if (!first) return `${label}：尚無資料`;
  const date = firstText(first.date, first.reportDate, first.performedAt);
  const title = firstText(first.title, first.examName, first.name, first.procedure, first.item);
  const hasReport = firstText(first.report, first.content, first.finding, first.impression) ? "可回工作站展開報告" : "無報告文字";
  return `${label}：${[date, title].filter(Boolean).join(" ")}（${hasReport}）`;
}

function valueOf(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "-";
}

function firstText(...values) {
  for (const value of values) {
    const text = displayText(value);
    if (text) return text;
  }
  return "";
}

function compact(value, maxLength) {
  const text = displayText(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function displayText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join("；");
  if (typeof value === "object") {
    for (const key of ["label", "text", "diagnosis", "admissionReason", "title", "name", "value"]) {
      const text = displayText(value[key]);
      if (text) return text;
    }
  }
  return "";
}
