import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuleBasedAssessment } from "./parsers/ai_assessment_stub.mjs";
import { fetchAdultAdmissionAssessment } from "./parsers/adult_assessment_parser.mjs";
import { fetchInpatientOrders } from "./parsers/orders_parser.mjs";
import { resolveCurrentAdmission } from "./parsers/onepage_current_admission.mjs";
import { loginOnepageViaBrowser } from "./parsers/onepage_browser_auth.mjs";
import { fetchOnepageVitals } from "./parsers/onepage_vitals_parser.mjs";
import { fetchOnepageClinicalSource } from "./parsers/onepage_clinical_parser.mjs";
import { fetchNursingCareRecords } from "./parsers/nursing_care_record_parser.mjs";
import { buildDiagnosisContext } from "./parsers/diagnosis_context_builder.mjs";
import { fetchBloodSugarInsulin } from "./parsers/nis_glucose_parser.mjs";
import { fetchIntakeOutputFromTpr } from "./parsers/nis_intake_output_parser.mjs";
import { fetchPhysicianInpatients } from "./parsers/onepage_physician_roster.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const localDir = join(__dirname, ".local");
const auditLogPath = join(localDir, "audit.ndjson");
const sessionStorePath = join(localDir, "sessions.json");
const recentPatientsPath = join(localDir, "recent_patients.json");
const host = process.env.API_HOST || "127.0.0.1";
const port = Number(process.env.API_PORT || 8766);
const sessionCookieName = "owb_session";
const activeSessions = new Map();
const patientCache = new Map();
const SESSION_TTL_MS = Number(process.env.WORKBENCH_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const PATIENT_CACHE_TTL_MS = Number(process.env.WORKBENCH_PATIENT_CACHE_TTL_MS || 10 * 60 * 1000);
const allowedOrigin = process.env.ALLOWED_ORIGIN || `http://${host}:${port}`;
const SOURCE_LABELS = {
  labs: "Labs",
  imaging: "影像報告",
  surgeries: "手術紀錄",
  nursing: "護理紀錄",
  glucose: "血糖/胰島素",
  intakeOutput: "輸入輸出",
};

function emptyIntakeOutput() {
  return {
    period: "尚未擷取",
    totals: { input: "", output: "", balance: "" },
    input: [],
    output: [],
  };
}

function makePendingPatient(query = "") {
  const ref = String(query || "").trim();
  const now = new Date().toISOString();

  return {
    patientRef: ref,
    chartNo: ref || "未指定",
    displayName: "待由 Onepage 識別",
    location: ref || "待查詢",
    bedNo: null,
    bedStatus: "pending_profile",
    bedSource: "Profile",
    source: "pending",
    updatedAt: now,
    warnings: [],
    message: "尚未從 Onepage 目前住院清單解析到本次住院資料。",
    summary: "尚未擷取資料。請輸入病歷號或床號後按查詢；後端會自動由 Onepage 目前住院清單解析本次住院資料。",
    clinicalContext: {
      currentDiagnoses: [],
      pastHistory: [],
      admissionReason: null,
      adultAdmissionAssessment: null,
      sourceExtracts: [
        {
          key: "orders",
          source: "住院醫囑",
          status: "可自動擷取",
          fields: ["完整醫囑列表", "開始/結束時間", "DC/出院醫囑", "簽收/給藥資訊"],
          lastResult: "由病歷號/床號解析目前住院後自動讀取。",
        },
        {
          key: "admission",
          source: "入院病摘",
          status: "待接 Onepage parser",
          fields: ["住院原因", "初始診斷", "治療計畫"],
          lastResult: "尚未擷取。",
        },
        {
          key: "progress",
          source: "Progress",
          status: "待接 Onepage parser",
          fields: ["problem list", "assessment", "plan"],
          lastResult: "尚未擷取。",
        },
        {
          key: "discharge",
          source: "出院病摘",
          status: "待接 Onepage parser",
          fields: ["過去住院結論", "既往診斷與治療史", "出院診斷"],
          lastResult: "尚未擷取。",
        },
        {
          key: "adult_assessment",
          source: "成人入院評估",
          status: "可自動擷取",
          fields: ["入院原因", "過去病史", "功能/護理評估"],
          lastResult: "已找到直接 endpoint，可由 NIS 讀取。",
        },
      ],
    },
    aiAssessment: null,
    vitals: [],
    labs: [],
    labMatrix: { columns: [], rows: [] },
    imaging: [],
    surgeries: [],
    nursing: [],
    orders: [],
    tpr: [],
    intakeOutput: emptyIntakeOutput(),
    itpr: [],
    glucose: [],
    noteSources: [
      { source: "住院醫囑", status: "可自動擷取", usage: "完整 active/DC orders、治療方向" },
      { source: "入院病摘", status: "待接 parser", usage: "住院原因、初始診斷、治療計畫" },
      { source: "Progress", status: "待接 parser", usage: "每日問題清單、最新 assessment/plan" },
      { source: "出院病摘", status: "待接 parser", usage: "既往診斷與治療史" },
      { source: "成人入院評估", status: "可自動擷取", usage: "過去病史、入院原因、護理評估" },
    ],
  };
}

function makeDemoPatient() {
  const patient = makePendingPatient("DEMO");
  return {
    ...patient,
    source: "demo",
    chartNo: "DEMO",
    displayName: "示範病人",
    bedNo: "示範床",
    bedStatus: "demo",
    message: "這是示範資料，僅用來檢查 UI，不可作為臨床判讀。",
    summary: "示範資料：真實查詢時，未擷取到的欄位會維持空白。",
    labs: [
      { item: "WBC", latest: "示範", trend: "", previous: "", flag: "" },
      { item: "Cr", latest: "示範", trend: "", previous: "", flag: "" },
    ],
    orders: [
      { start: "示範", end: "", dischargeOrder: "", dc: "", item: "完整醫囑表格會列出所有 rows", signer: "", signedAt: "", giver: "", givenAt: "" },
    ],
  };
}

async function buildPatientFromQuery(query, user = null) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery || normalizedQuery.length > 64 || /[<>\\]/.test(normalizedQuery)) {
    return { ...makePendingPatient(""), source: "invalid_query", message: "查詢值格式不符，請輸入病歷號、住院序號或床號。", summary: "未執行查詢：查詢值格式不符。" };
  }
  const basePatient = normalizedQuery.toUpperCase() === "DEMO" ? makeDemoPatient() : makePendingPatient(normalizedQuery);
  if (basePatient.source === "demo") return basePatient;

  const onepageToken = user?.onepageAuthToken || "";
  const resolved = await resolveCurrentAdmission({ query, authToken: onepageToken, userId: user?.username || "" });
  if (resolved.status !== "ok") {
    return {
      ...basePatient,
      source: resolved.status,
      message: resolved.message,
      summary: resolved.message,
    };
  }

  const admission = resolved.admission;
  const identifiedPatient = {
    ...basePatient,
    chartNo: admission.chartNo || basePatient.chartNo,
    patientRef: admission.chartNo || basePatient.patientRef,
    displayName: admission.name || basePatient.displayName,
    bedNo: admission.bedNo || basePatient.bedNo,
    bedSource: admission.bedNo ? "Onepage 目前住院清單" : basePatient.bedSource,
    feeno: admission.feeNo || null,
  };

  if (!admission.feeNo) {
    return {
      ...identifiedPatient,
      source: "missing_admission_id",
      message: "Onepage 找到病人，但沒有回傳本次住院 fee_no，無法讀取 NIS 資料。",
      summary: "Onepage 找到病人，但沒有回傳本次住院 fee_no。",
    };
  }

  const sourceResult = await refreshSources(
    { patientRef: identifiedPatient.chartNo, feeno: admission.feeNo, onepageAuthToken: onepageToken },
    ["orders", "adult_assessment", "vitals", "labs", "imaging", "surgeries", "nursing", "glucose", "intakeOutput"]
  );
  const merged = mergeSourceResultIntoPatient(identifiedPatient, sourceResult);
  return {
    ...merged,
    aiAssessment: buildRuleBasedAssessment(merged),
  };
}

function mergeSourceResultIntoPatient(patient, result) {
  const requestedChartNo = String(patient.chartNo || patient.patientRef || "").trim();
  const returnedChartNo = String(result.profile?.chartNo || "").trim();
  if (requestedChartNo && returnedChartNo && requestedChartNo !== returnedChartNo) {
    return {
      ...patient,
      source: "blocked_mismatch",
      updatedAt: new Date().toISOString(),
      message: `NIS 回傳病歷號 ${returnedChartNo}，與目前查詢 ${requestedChartNo} 不一致，已阻擋資料顯示。請確認目前住院資料是否屬於此病人。`,
      warnings: ["病歷號與目前住院資料不一致，已阻擋資料合併。"],
      summary: "資料未顯示：目前住院資料與查詢病歷號不一致。",
      feeno: result.feeno || patient.feeno || null,
    };
  }

  const merged = {
    ...patient,
    source: result.status === "ok" ? "nis" : patient.source,
    updatedAt: result.updatedAt || new Date().toISOString(),
    message: result.message || patient.message,
    feeno: result.feeno || patient.feeno || null,
  };

  if (Array.isArray(result.orders)) {
    merged.orders = result.orders;
  }

  if (result.ordersMeta) {
    merged.ordersMeta = result.ordersMeta;
  }

  if (Array.isArray(result.vitals)) {
    merged.vitals = result.vitals;
  }

  if (Array.isArray(result.tpr)) {
    merged.tpr = result.tpr;
  }

  if (Array.isArray(result.itpr)) {
    merged.itpr = result.itpr;
  }

  if (Array.isArray(result.labs)) {
    merged.labs = result.labs;
  }

  if (result.labMatrix) {
    merged.labMatrix = result.labMatrix;
  }

  if (Array.isArray(result.imaging)) {
    merged.imaging = result.imaging;
  }

  if (Array.isArray(result.surgeries)) {
    merged.surgeries = result.surgeries;
  }

  if (Array.isArray(result.nursing)) {
    merged.nursing = result.nursing;
  }

  if (Array.isArray(result.glucose)) {
    merged.glucose = result.glucose;
  }

  if (result.intakeOutput) {
    merged.intakeOutput = result.intakeOutput;
  }

  if (result.profile) {
    merged.chartNo = result.profile.chartNo || merged.chartNo;
    merged.displayName = result.profile.name || merged.displayName;
    merged.bedNo = result.profile.bedNo || merged.bedNo;
    merged.bedSource = result.profile.bedNo ? "NIS 住院醫囑頁" : merged.bedSource;
  }

  if (result.adultAdmissionAssessment) {
    merged.clinicalContext = {
      ...merged.clinicalContext,
      adultAdmissionAssessment: result.adultAdmissionAssessment,
      admissionReason: result.adultAdmissionAssessment.admissionReason
        ? { source: result.adultAdmissionAssessment.source, text: result.adultAdmissionAssessment.admissionReason }
        : merged.clinicalContext.admissionReason,
      pastHistory: result.adultAdmissionAssessment.pastHistory
        ? [{ source: result.adultAdmissionAssessment.source, text: result.adultAdmissionAssessment.pastHistory }]
        : merged.clinicalContext.pastHistory,
    };
  }

  merged.clinicalContext = buildDiagnosisContext(merged);

  const sourceStatuses = new Map((result.sourceResults || []).map((item) => [item.source, item]));
  merged.clinicalContext.sourceExtracts = (merged.clinicalContext.sourceExtracts || []).map((source) => {
    const status = sourceStatuses.get(source.key);
    if (!status) return source;
    return {
      ...source,
      status: status.status,
      lastResult: status.status === "ok" ? `已擷取 ${status.count || 0} 筆${status.endpoint ? ` (${status.endpoint})` : ""}` : compactSourceError(status.message || result.message),
    };
  });
  for (const status of result.sourceResults || []) {
    if (!SOURCE_LABELS[status.source]) continue;
    if (merged.clinicalContext.sourceExtracts.some((source) => source.key === status.source)) continue;
    merged.clinicalContext.sourceExtracts.push({
      key: status.source,
      source: SOURCE_LABELS[status.source],
      status: status.status,
      fields: [],
      lastResult: status.status === "ok" ? `已擷取 ${status.count || 0} 筆${status.endpoint ? ` (${status.endpoint})` : ""}` : compactSourceError(status.message || ""),
    });
  }
  const lines = [];
  if (merged.displayName && merged.displayName !== "待由 Onepage 識別") lines.push(`姓名：${merged.displayName}`);
  if (merged.bedNo) lines.push(`床號：${merged.bedNo}`);
  if (merged.orders?.length) lines.push(`住院醫囑：${merged.orders.length} 筆`);
  if (result.adultAdmissionAssessment?.admissionReason) lines.push(`入院原因：${result.adultAdmissionAssessment.admissionReason}`);
  if (result.adultAdmissionAssessment?.pastHistory) lines.push(`過去病史：${result.adultAdmissionAssessment.pastHistory}`);
  merged.summary = lines.length ? lines.join("\n") : merged.summary;

  return merged;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function jsonWithCookie(res, status, payload, cookie) {
  const body = JSON.stringify(payload, null, 2);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(status, headers);
  res.end(body);
}

function makeSessionCookie(sessionId, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  return `${sessionCookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

async function loadSessionsFromDisk() {
  try {
    const raw = await readFile(sessionStorePath, "utf8");
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const item of Array.isArray(data?.sessions) ? data.sessions : []) {
      if (!item?.sessionId || !item?.session || Number(item.session.expiresAt || 0) <= now) continue;
      activeSessions.set(String(item.sessionId), item.session);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Unable to load session store: ${error.message}`);
    }
  }
}

async function persistSessions() {
  await mkdir(localDir, { recursive: true });
  clearExpiredSessions();
  const sessions = Array.from(activeSessions.entries()).map(([sessionId, session]) => ({ sessionId, session }));
  await writeFile(sessionStorePath, JSON.stringify({ sessions }, null, 2), { encoding: "utf8", mode: 0o600 });
}

async function loadRecentPatients(username) {
  try {
    const raw = await readFile(recentPatientsPath, "utf8");
    const data = JSON.parse(raw);
    const key = safeUserId(username || "default") || "default";
    return Array.isArray(data?.[key]) ? data[key].slice(0, 20) : [];
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`Unable to load recent patients: ${error.message}`);
    return [];
  }
}

async function rememberRecentPatient(username, patient) {
  if (!patient || !patient.chartNo || patient.source === "invalid_query") return;
  await mkdir(localDir, { recursive: true });
  let data = {};
  try {
    data = JSON.parse(await readFile(recentPatientsPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`Unable to read recent patients before update: ${error.message}`);
  }
  const key = safeUserId(username || "default") || "default";
  const item = {
    patientRef: patient.chartNo || patient.patientRef || "",
    chartNo: patient.chartNo || "",
    displayName: patient.displayName || "",
    bedNo: patient.bedNo || "",
    location: patient.bedNo ? `床 ${patient.bedNo}` : patient.chartNo || patient.patientRef || "",
    updatedAt: patient.updatedAt || new Date().toISOString(),
    warningCount: patient.warnings?.length || 0,
  };
  const previous = Array.isArray(data[key]) ? data[key] : [];
  data[key] = [item, ...previous.filter((row) => row.patientRef !== item.patientRef)].slice(0, 20);
  await writeFile(recentPatientsPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}


function safeUserId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 64);
}

function clearExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions) {
    if (!session || Number(session.expiresAt || 0) <= now) activeSessions.delete(sessionId);
  }
}

function publicUser(session) {
  if (!session) return null;
  return {
    username: session.username,
    displayName: session.displayName || session.username,
  };
}

function patientCacheKey(username, query) {
  return `${safeUserId(username || "default")}:${String(query || "").trim().toLowerCase()}`;
}

function getCachedPatient(username, query) {
  const item = patientCache.get(patientCacheKey(username, query));
  if (!item || Date.now() - Number(item.cachedAt || 0) > PATIENT_CACHE_TTL_MS) return null;
  return { ...item.patient, cacheStatus: "memory_cache" };
}

function setCachedPatient(username, query, patient) {
  if (!patient || !query || patient.source === "invalid_query") return;
  patientCache.set(patientCacheKey(username, query), { cachedAt: Date.now(), patient });
  if (patient.chartNo && patient.chartNo !== query) {
    patientCache.set(patientCacheKey(username, patient.chartNo), { cachedAt: Date.now(), patient });
  }
  if (patient.bedNo) {
    patientCache.set(patientCacheKey(username, patient.bedNo), { cachedAt: Date.now(), patient });
  }
}

async function getCurrentUser(req) {
  clearExpiredSessions();
  const sessionId = parseCookies(req)[sessionCookieName];
  if (!sessionId) return null;
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  return session;
}

async function requireUser(req, res) {
  const user = await getCurrentUser(req);
  if (!user) {
    json(res, 401, { error: "auth_required", message: "請使用 Onepage 帳號登入查房工作台。" });
    return null;
  }
  return user;
}

async function loginOnepageUser({ username, password }) {
  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername || String(password || "").length < 1) {
    return { ok: false, status: 400, error: "invalid_login", message: "請輸入 Onepage 帳號與密碼。" };
  }

  try {
    // 密碼只傳入這一次瀏覽器登入流程；不寫入磁碟、log 或 cookie。
    const onepage = await loginOnepageViaBrowser({ username: normalizedUsername, password: String(password) });
    const sessionId = randomBytes(32).toString("hex");
    const now = new Date();
    const session = {
      username: safeUserId(onepage.username || normalizedUsername) || normalizedUsername,
      displayName: String(onepage.displayName || normalizedUsername).trim() || normalizedUsername,
      onepageAuthToken: onepage.authToken,
      onepageLoggedInAt: now.toISOString(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    activeSessions.set(sessionId, session);
    await persistSessions();
    return { ok: true, sessionId, user: publicUser(session), validationWarning: onepage.validationWarning || "" };
  } catch (error) {
    return {
      ok: false,
      status: 401,
      error: "onepage_login_failed",
      message: error?.message || "Onepage 登入失敗。",
    };
  }
}

function readOnepageSessionMeta(user) {
  if (!user) return { configured: false, updatedAt: null, source: null };
  const token = String(user.onepageAuthToken || "");
  return {
    configured: /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),
    updatedAt: user.onepageLoggedInAt || null,
    expiresAt: user.expiresAt ? new Date(user.expiresAt).toISOString() : null,
    source: "onepage-direct-login",
    username: user.username,
  };
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function safePublicPath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(requested);
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  return join(publicDir, normalized);
}

async function serveStatic(req, res) {
  try {
    const filePath = safePublicPath(new URL(req.url, `http://${req.headers.host}`).pathname);
    if (!filePath.startsWith(publicDir)) {
      notFound(res);
      return;
    }

    const data = await readFile(filePath);
    const mime = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    }[extname(filePath)] || "application/octet-stream";

    res.writeHead(200, {
      "content-type": mime,
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function refreshSources(body, sources) {
  const sourceResults = sources.map((source) => ({
    source,
    status: "pending_parser",
    updatedAt: new Date().toISOString(),
  }));

  let adultAdmissionAssessment = null;
  let ordersResult = null;
  let vitalsResult = null;
  let glucoseResult = null;
  let intakeOutputResult = null;
  const clinicalResults = {};
  let profile = null;

  const markOk = (source, details = {}) => {
    const result = sourceResults.find((item) => item.source === source);
    if (result) Object.assign(result, { status: "ok" }, details);
  };
  const markError = (source, error) => {
    const result = sourceResults.find((item) => item.source === source);
    if (result) {
      result.status = "error";
      result.message = error?.message || String(error || "");
    }
  };

  const tasks = [];

  if (sources.includes("adult_assessment") && body.feeno) {
    tasks.push((async () => {
      try {
        adultAdmissionAssessment = await fetchAdultAdmissionAssessment({
          feeno: body.feeno,
          nisBase: process.env.NIS_BASE || "http://10.125.254.46/NIS",
        });
        markOk("adult_assessment");
      } catch (error) {
        markError("adult_assessment", error);
      }
    })());
  }

  if (sources.includes("orders") && body.feeno) {
    tasks.push((async () => {
      try {
        ordersResult = await fetchInpatientOrders({
          feeno: body.feeno,
          ordersUrl: process.env.ORDERS_URL || "http://10.125.254.53:90/Desktop/ipd_allorder.asp",
        });
        profile = ordersResult.profile || null;
        markOk("orders", { count: ordersResult.orders.length });
      } catch (error) {
        markError("orders", error);
      }
    })());
  }

  if (sources.includes("vitals") && body.feeno) {
    tasks.push((async () => {
      try {
        vitalsResult = await fetchOnepageVitals({
          feeno: body.feeno,
          authToken: body.onepageAuthToken || process.env.ONEPAGE_AUTH_TOKEN || "",
        });
        markOk("vitals", { count: vitalsResult.itpr.length });
      } catch (error) {
        markError("vitals", error);
      }
    })());
  }

  for (const source of ["labs", "imaging", "surgeries"]) {
    if (!sources.includes(source) || !body.feeno) continue;
    tasks.push((async () => {
      try {
        const clinicalResult = await fetchOnepageClinicalSource({
          source,
          feeno: body.feeno,
          chartNo: body.patientRef || body.chartNo || "",
          authToken: body.onepageAuthToken || process.env.ONEPAGE_AUTH_TOKEN || "",
        });
        clinicalResults[source] = clinicalResult;
        markOk(source, { count: clinicalResult.rows.length, endpoint: clinicalResult.endpoint });
      } catch (error) {
        markError(source, error);
      }
    })());
  }

  if (sources.includes("nursing") && body.feeno) {
    tasks.push((async () => {
      try {
        const nursingResult = await fetchNursingCareRecords({
          feeno: body.feeno,
          nisBase: process.env.NIS_BASE || "http://10.125.254.46/NIS",
        });
        clinicalResults.nursing = nursingResult;
        markOk("nursing", { count: nursingResult.rows.length, endpoint: nursingResult.endpoint });
      } catch (error) {
        markError("nursing", error);
      }
    })());
  }

  if (sources.includes("glucose") && body.feeno) {
    tasks.push((async () => {
      try {
        glucoseResult = await fetchBloodSugarInsulin({
          feeno: body.feeno,
          nisBase: process.env.NIS_BASE || "http://10.125.254.46/NIS",
        });
        markOk("glucose", { count: glucoseResult.rows.length, endpoint: glucoseResult.endpoint });
      } catch (error) {
        markError("glucose", error);
      }
    })());
  }

  if (sources.includes("intakeOutput") && body.feeno) {
    tasks.push((async () => {
      try {
        intakeOutputResult = await fetchIntakeOutputFromTpr({
          feeno: body.feeno,
          nisBase: process.env.NIS_BASE || "http://10.125.254.46/NIS",
        });
        markOk("intakeOutput", {
          count: (intakeOutputResult.input?.length || 0) + (intakeOutputResult.output?.length || 0) + (intakeOutputResult.totals?.length || 0),
          endpoint: intakeOutputResult.endpoint,
        });
      } catch (error) {
        markError("intakeOutput", error);
      }
    })());
  }

  await Promise.all(tasks);

  const ok = sourceResults.some((item) => item.status === "ok");
  return {
    patientRef: body.patientRef || body.query || "",
    feeno: body.feeno || null,
    requestedSources: sources,
    status: ok ? "ok" : "queued",
    message: ok ? "已擷取可用來源。" : "尚未擷取到可用來源；請確認 Onepage 登入是否仍有效或 parser 是否已接上。",
    updatedAt: new Date().toISOString(),
    adultAdmissionAssessment,
    orders: ordersResult?.orders || null,
    ordersMeta: ordersResult ? {
      queryRange: ordersResult.queryRange || null,
      allAdmissionOrders: !!ordersResult.allAdmissionOrders,
      capturedAt: ordersResult.capturedAt || null,
    } : null,
    vitals: vitalsResult?.vitals || null,
    tpr: vitalsResult?.tpr || null,
    itpr: vitalsResult?.itpr || null,
    labs: clinicalResults.labs?.rows || null,
    labMatrix: buildLabMatrix(clinicalResults.labs?.rows || []),
    imaging: clinicalResults.imaging?.rows || null,
    surgeries: clinicalResults.surgeries?.rows || null,
    nursing: clinicalResults.nursing?.rows || null,
    glucose: glucoseResult?.rows || null,
    intakeOutput: intakeOutputResult ? {
      period: intakeOutputResult.period,
      columns: intakeOutputResult.columns || [],
      totals: intakeOutputResult.totals || [],
      input: intakeOutputResult.input || [],
      output: intakeOutputResult.output || [],
    } : null,
    profile,
    sourceResults,
  };
}

function buildLabMatrix(labs = []) {
  const columns = [...new Set(labs.map((row) => row.time).filter(Boolean))].slice(0, 8);
  const items = [...new Set(labs.map((row) => row.item).filter(Boolean))];
  const rows = items.map((item) => {
    const values = {};
    for (const column of columns) {
      const found = labs.find((row) => row.item === item && row.time === column);
      values[column] = found ? {
        value: found.latest || "",
        unit: found.unit || "",
        flag: normalizeLabFlag(found),
        rawFlag: found.flag || "",
        ref: found.ref || "",
      } : null;
    }
    const sample = labs.find((row) => row.item === item) || {};
    return { item, group: normalizeLabGroup(sample), unit: sample.unit || "", ref: sample.ref || "", values };
  });
  return { columns, rows };
}

function normalizeLabGroup(row = {}) {
  const text = [row.group, row.kind, row.item].filter(Boolean).join(" ").toLowerCase();
  if (/urine|u\/a|urinalysis|sediment|尿/.test(text)) return "urine";
  if (/blood|serum|plasma|cbc|wbc|rbc|hgb|hct|platelet|bun|creatinine|sodium|potassium|chloride|ast|alt|glucose|血/.test(text)) return "blood";
  return "other";
}

function normalizeLabFlag(row = {}) {
  const flag = String(row.flag || "").trim().toLowerCase();
  if (/^(h|hi|high|\+|↑|red|abnormal high)$/.test(flag) || /\bh\b|high|↑/.test(flag)) return "high";
  if (/^(l|lo|low|↓|blue|abnormal low)$/.test(flag) || /\bl\b|low|↓/.test(flag)) return "low";
  const numeric = Number.parseFloat(String(row.latest || "").replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return "";
  const ref = parseReferenceRange(row.ref || row.reference || "");
  if (!ref) return "";
  if (ref.low !== null && numeric < ref.low) return "low";
  if (ref.high !== null && numeric > ref.high) return "high";
  return "";
}

function parseReferenceRange(refText) {
  const text = String(refText || "").replace(/,/g, "").trim();
  if (!text) return null;
  const range = text.match(/(-?\d+(?:\.\d+)?)\s*[-~]\s*(-?\d+(?:\.\d+)?)/);
  if (range) return { low: Number(range[1]), high: Number(range[2]) };
  const lessThan = text.match(/[<≤]\s*(-?\d+(?:\.\d+)?)/);
  if (lessThan) return { low: null, high: Number(lessThan[1]) };
  const greaterThan = text.match(/[>≥]\s*(-?\d+(?:\.\d+)?)/);
  if (greaterThan) return { low: Number(greaterThan[1]), high: null };
  return null;
}

function compactSourceError(message = "") {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const serviceMatch = text.match(/Service '([^']+)' is not found/);
  if (serviceMatch) return `endpoint 不存在：${serviceMatch[1]}`;
  return text.slice(0, 160);
}

async function appendAudit({ actor, action, patientRef = "", outcome = "", detail = {} }) {
  const patientHash = patientRef ? createHash("sha256").update(String(patientRef)).digest("hex").slice(0, 20) : "";
  const record = { at: new Date().toISOString(), actor: String(actor || "unknown"), action, patientHash, outcome, detail };
  await mkdir(localDir, { recursive: true });
  await appendFile(auditLogPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function routeApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const user = await getCurrentUser(req);
    json(res, 200, {
      ok: true,
      service: "onepage-med-relay",
      mode: "ui-direct-onepage-http-login",
      pid: process.pid,
      loginMethod: "onepage-api-auth.login",
      time: new Date().toISOString(),
      user: publicUser(user),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const result = await loginOnepageUser(body);
    if (!result.ok) {
      await appendAudit({ actor: safeUserId(body.username), action: "onepage_login", outcome: result.error, detail: { message: result.message } });
      json(res, result.status, { error: result.error, message: result.message });
      return;
    }
    await appendAudit({ actor: result.user.username, action: "onepage_login", outcome: "ok", detail: { validationWarning: result.validationWarning || "" } });
    jsonWithCookie(res, 200, { ok: true, user: result.user, onepage: { configured: true, source: "onepage-direct-login", validationWarning: result.validationWarning || "" } }, makeSessionCookie(result.sessionId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const sessionId = parseCookies(req)[sessionCookieName];
    const user = await getCurrentUser(req);
    if (sessionId) activeSessions.delete(sessionId);
    await persistSessions();
    if (user) await appendAudit({ actor: user.username, action: "logout", outcome: "ok" });
    jsonWithCookie(res, 200, { ok: true }, makeSessionCookie("", 0));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = await requireUser(req, res);
    if (!user) return;
    json(res, 200, { ok: true, user: publicUser(user), onepage: readOnepageSessionMeta(user) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/patients/recent") {
    const user = await requireUser(req, res);
    if (!user) return;
    json(res, 200, { patients: await loadRecentPatients(user.username) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/physicians/inpatients") {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const doctorId = String(body.doctorId || body.query || "").trim();
    if (!doctorId || doctorId.length > 32 || /[<>\\]/.test(doctorId)) {
      json(res, 400, { error: "invalid_doctor_id", message: "請輸入有效的醫師員工編號。" });
      return;
    }
    const roster = await fetchPhysicianInpatients({ doctorId, authToken: user.onepageAuthToken || "" });
    await appendAudit({ actor: user.username, action: "physician_inpatients", outcome: roster.status, detail: { doctorId, count: roster.patients?.length || 0 } });
    json(res, 200, roster);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/patients/search") {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const query = String(body.query || "").trim();
    const cached = getCachedPatient(user.username, query);
    if (cached) {
      await appendAudit({ actor: user.username, action: "patient_search_cache", patientRef: query, outcome: cached.source || "unknown", detail: { hasFeeNo: !!cached.feeno } });
      json(res, 200, cached);
      return;
    }
    const patient = await buildPatientFromQuery(query, user);
    setCachedPatient(user.username, query, patient);
    await rememberRecentPatient(user.username, patient);
    await appendAudit({ actor: user.username, action: "patient_search", patientRef: query, outcome: patient.source || "unknown", detail: { hasFeeNo: !!patient.feeno } });
    json(res, 200, patient);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/patients/refresh") {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const query = body.patientRef || body.query || "";
    const patient = { ...(await buildPatientFromQuery(query, user)), refreshed: true };
    setCachedPatient(user.username, query, patient);
    await rememberRecentPatient(user.username, patient);
    await appendAudit({ actor: user.username, action: "patient_refresh", patientRef: query, outcome: patient.source || "unknown", detail: { hasFeeNo: !!patient.feeno } });
    json(res, 200, patient);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/context/refresh") {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const sources = body.sources || ["orders", "admission", "progress", "discharge", "adult_assessment"];
    json(res, 200, await refreshSources({ ...body, onepageAuthToken: user.onepageAuthToken || "" }, sources));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/refresh") {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    json(res, 200, await refreshSources({ ...body, onepageAuthToken: user.onepageAuthToken || "" }, ["orders"]));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ai/assessment") {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const patient = body.patient || makePendingPatient(body.patientRef || body.query || "");
    const assessment = buildRuleBasedAssessment(patient);
    json(res, 200, {
      patientRef: body.patientRef || patient.patientRef || "",
      ...assessment,
    });
    return;
  }

  notFound(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: "internal_error", message: error.message });
  }
});

await loadSessionsFromDisk();

server.listen(port, host, () => {
  console.log(`Onepage Med Relay UI listening at http://${host}:${port}`);
});
