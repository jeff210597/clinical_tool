import { mkdir, readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import { patientRoundingSummary, patientLabHistory, physicianRosterSummary, refreshRelayOnepageSession } from "../services/relay_summary.mjs";

const subtle = webcrypto.subtle;
const MAX_RESPONSE_BYTES = 480 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const MIN_POLL_INTERVAL_MS = 1500;
const relayDisabledPath = new URL("../.local/cloudflare_shadow_relay.disabled.json", import.meta.url);

await loadEnvFile(new URL("../.env", import.meta.url));
await loadEnvFile(new URL("../../.env", import.meta.url));

const config = {
  apiBase: (process.env.CF_SHADOW_API_BASE || "").replace(/\/$/, ""),
  relayKey: process.env.CF_SHADOW_RELAY_KEY || "",
  // Keep outbound-only polling responsive without allowing a configuration
  // change to create sub-1.5-second traffic bursts on the hospital network.
  intervalMs: Math.max(MIN_POLL_INTERVAL_MS, Number(process.env.CF_SHADOW_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS)),
  echoOnly: process.argv.includes("--echo-only") || process.env.CF_SHADOW_ECHO_ONLY === "1",
};

if (process.argv.includes("--check-config")) {
  validateConfig();
  console.log(`Cloudflare shadow relay config OK. API: ${config.apiBase}`);
  console.log("Mode: outbound HTTPS polling only; no inbound listener, no tunnel.");
  process.exit(0);
}

validateConfig();
console.log(`Cloudflare shadow relay polling ${config.apiBase}`);
console.log("Network mode: outbound HTTPS polling only; no inbound listener, no tunnel.");
if (config.echoOnly) console.log("Echo-only mode enabled. Clinical requests will be rejected.");

if (process.argv.includes("--once")) {
  await pollOnce();
  process.exit(0);
}

while (true) {
  try {
    await pollOnce();
  } catch (error) {
    console.error(`cloudflare shadow poll error: ${redact(error.message || error)}`);
  }
  await sleep(config.intervalMs);
}

async function pollOnce() {
  const pending = await shadowFetch("/api/cf-shadow/agent/poll");
  const requests = pending.requests || [];
  for (const request of requests) {
    await processRequest(request);
  }
}

async function processRequest(request) {
  try {
    let result = null;
    let stopAfterResponse = false;
    if (request.type === "echo") {
      result = {
        ok: true,
        echo: request.payload?.text || "pong",
        handledAt: new Date().toISOString(),
        mode: "cloudflare-poc",
      };
    } else if (config.echoOnly) {
      throw new Error("Echo-only mode is enabled; refusing clinical request.");
    } else if (request.type === "ward") {
      result = await physicianRosterSummary(request.payload?.doctorId);
    } else if (request.type === "summary") {
      result = await patientRoundingSummary(request.payload?.query, null, request.payload || {});
    } else if (request.type === "labs") {
      result = await patientLabHistory(request.payload?.query, request.payload || {});
    } else if (request.type === "session_refresh") {
      result = await refreshRelayOnepageSession();
    } else if (request.type === "relay_control" && request.payload?.action === "disable") {
      result = await disableShadowRelay();
      stopAfterResponse = true;
    } else {
      throw new Error(`Unsupported request type: ${request.type}`);
    }
    let responseResult = await maybeEncryptResult(request, result);
    let responseBody = JSON.stringify({ id: request.id, status: "done", result: responseResult });
    if (responseBody.length > MAX_RESPONSE_BYTES) {
      responseResult = await maybeEncryptResult(request, compactCloudflareResult(result));
      responseBody = JSON.stringify({ id: request.id, status: "done", result: responseResult });
    }
    if (responseBody.length > MAX_RESPONSE_BYTES) {
      throw new Error(`Cloudflare shadow response too large: ${responseBody.length} bytes`);
    }
    await shadowFetch("/api/cf-shadow/agent/respond", {
      method: "POST",
      body: responseBody,
    });
    console.log(`cloudflare shadow request ${request.id} done (${request.type})`);
    if (stopAfterResponse) {
      console.log("Cloudflare shadow relay disabled locally; stopping outbound polling.");
      process.exit(0);
    }
  } catch (error) {
    const errorText = relaySafeError(error);
    const encryptedError = await maybeEncryptResult(request, { ok: false, error: errorText.message, ...errorText }).catch(() => null);
    await shadowFetch("/api/cf-shadow/agent/respond", {
      method: "POST",
      body: JSON.stringify({
        id: request.id,
        status: "error",
        error: encryptedError ? "encrypted_error" : errorText.code,
        result: encryptedError,
      }),
    }).catch((postError) => console.error(`failed posting error result: ${redact(postError.message || postError)}`));
    console.error(`cloudflare shadow request ${request.id} failed: ${errorText.code}`);
  }
}

async function disableShadowRelay() {
  await mkdir(new URL("../.local/", import.meta.url), { recursive: true });
  const disabledAt = new Date().toISOString();
  await writeFile(relayDisabledPath, `${JSON.stringify({ disabledAt, source: "shadow_remote_control" })}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    ok: true,
    code: "shadow_relay_disabled",
    disabledAt,
    message: "Shadow relay is disabled on the hospital host. Outbound Cloudflare polling has stopped.",
  };
}

function relaySafeError(error) {
  const code = String(error?.code || "");
  if (code === "onepage_refresh_cooldown") return { code, message: "Onepage automatic refresh is temporarily cooling down." };
  if (code === "onepage_credential_missing") return { code, message: "Onepage relay credential is not configured on the hospital host." };
  if (code === "onepage_refresh_failed") return { code, message: "Onepage session refresh failed on the hospital host." };
  if (code === "missing_onepage_session") return { code, message: "Onepage session is unavailable on the hospital host." };
  return { code: "relay_request_failed", message: "The hospital relay could not complete this request." };
}

async function maybeEncryptResult(request, result) {
  const publicKeyJwk = request.payload?.crypto?.ecdhPublicKey;
  if (!publicKeyJwk) return result;
  const useCompression = request.payload?.crypto?.compression === "gzip";
  const peerPublicKey = await subtle.importKey(
    "jwk",
    JSON.parse(base64UrlDecode(publicKeyJwk)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const keyPair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const aesKey = await subtle.deriveKey(
    { name: "ECDH", public: peerPublicKey },
    keyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const plaintext = useCompression
    ? gzipSync(Buffer.from(JSON.stringify(result), "utf8"))
    : new TextEncoder().encode(JSON.stringify(result));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  const agentPublicJwk = await subtle.exportKey("jwk", keyPair.publicKey);
  return {
    encrypted: true,
    alg: "ECDH-P-256+A256GCM",
    ...(useCompression ? { compression: "gzip" } : {}),
    ecdhPublicKey: base64UrlEncode(JSON.stringify(agentPublicJwk)),
    iv: base64UrlEncodeBytes(iv),
    ciphertext: base64UrlEncodeBytes(new Uint8Array(ciphertext)),
  };
}

function compactCloudflareResult(result) {
  if (!result || typeof result !== "object") return result;
  const compacted = { ...result };
  if (result.patient && typeof result.patient === "object") {
    compacted.patient = compactPatient(result.patient);
    compacted.text = `${result.text || ""}\n\n[影子版提示] 此病人資料量超過 Cloudflare 暫存限制，已保留摘要與各分頁最近重點，長篇報告已截短。`.trim();
  }
  if (result.roster && typeof result.roster === "object") {
    compacted.roster = {
      ...result.roster,
      patients: limitArray(result.roster.patients, 80, (row) => compactObject(row, 280)),
    };
  }
  return compacted;
}

function compactPatient(patient) {
  return compactObject({
    ...patient,
    tpr: limitArray(patient.tpr || patient.vitals, 80, (row) => compactObject(row, 180)),
    vitals: limitArray(patient.vitals, 80, (row) => compactObject(row, 180)),
    labs: limitArray(patient.labs, 160, (row) => compactObject(row, 180)),
    labMatrix: compactLabMatrix(patient.labMatrix),
    imaging: limitArray(patient.imaging, 30, compactReportRow),
    surgeries: limitArray(patient.surgeries, 20, compactReportRow),
    pathology: limitArray(patient.pathology, 20, compactReportRow),
    orders: limitArray(patient.orders, 180, (row) => compactObject(row, 240)),
    nursing: limitArray(patient.nursing, 180, (row) => compactObject(row, 260)),
    glucose: limitArray(patient.glucose, 80, (row) => compactObject(row, 160)),
  }, 600);
}

function compactLabMatrix(matrix) {
  if (!matrix || typeof matrix !== "object") return matrix;
  return compactObject({
    ...matrix,
    rows: limitArray(matrix.rows, 80, (row) => compactObject(row, 180)),
    columns: limitArray(matrix.columns, 3, (row) => compactObject(row, 120)),
  }, 300);
}

function compactReportRow(row) {
  return compactObject(row, 600, {
    report: 1800,
    content: 1800,
    impression: 900,
    finding: 1200,
    findings: 1200,
    note: 1200,
    operativeProcedure: 1800,
    operativeFindings: 1400,
    procedure: 500,
  });
}

function compactObject(value, defaultStringLimit = 320, perKeyLimits = {}) {
  if (value == null || typeof value !== "object") return compactScalar(value, defaultStringLimit);
  if (Array.isArray(value)) return limitArray(value, 40, (item) => compactObject(item, defaultStringLimit, perKeyLimits));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const limit = perKeyLimits[key] || defaultStringLimit;
    out[key] = item && typeof item === "object" ? compactObject(item, limit, perKeyLimits) : compactScalar(item, limit);
  }
  return out;
}

function compactScalar(value, maxLength) {
  if (typeof value !== "string") return value;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 18))}... [truncated]`;
}

function limitArray(value, maxItems, mapper) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(0, maxItems).map(mapper);
}

async function shadowFetch(path, options = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-relay-key": config.relayKey,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Cloudflare shadow API ${response.status}`);
  return payload;
}

function validateConfig() {
  const missing = [];
  if (!config.apiBase) missing.push("CF_SHADOW_API_BASE");
  if (!config.relayKey) missing.push("CF_SHADOW_RELAY_KEY");
  if (missing.length) throw new Error(`Cloudflare shadow relay missing env: ${missing.join(", ")}`);
  if (!/^https:\/\/[^/]+/.test(config.apiBase)) throw new Error("CF_SHADOW_API_BASE must be an HTTPS URL.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value) {
  return String(value || "").replace(/[A-Za-z0-9_\-.]{24,}/g, "[redacted]");
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlEncodeBytes(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function loadEnvFile(url) {
  let raw = "";
  try {
    raw = await readFile(url, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
