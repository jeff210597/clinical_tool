import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { patientRoundingSummary, physicianRosterSummary } from "../services/relay_summary.mjs";

const subtle = webcrypto.subtle;

await loadEnvFile(new URL("../.env", import.meta.url));
await loadEnvFile(new URL("../../.env", import.meta.url));

const config = {
  apiBase: (process.env.CF_SHADOW_API_BASE || "").replace(/\/$/, ""),
  relayKey: process.env.CF_SHADOW_RELAY_KEY || "",
  intervalMs: Number(process.env.CF_SHADOW_POLL_INTERVAL_MS || 3000),
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
      result = await patientRoundingSummary(request.payload?.query);
    } else {
      throw new Error(`Unsupported request type: ${request.type}`);
    }
    const responseResult = await maybeEncryptResult(request, result);
    await shadowFetch("/api/cf-shadow/agent/respond", {
      method: "POST",
      body: JSON.stringify({ id: request.id, status: "done", result: responseResult }),
    });
    console.log(`cloudflare shadow request ${request.id} done (${request.type})`);
  } catch (error) {
    await shadowFetch("/api/cf-shadow/agent/respond", {
      method: "POST",
      body: JSON.stringify({ id: request.id, status: "error", error: redact(error.message || error) }),
    }).catch((postError) => console.error(`failed posting error result: ${redact(postError.message || postError)}`));
    console.error(`cloudflare shadow request ${request.id} failed: ${redact(error.message || error)}`);
  }
}

async function maybeEncryptResult(request, result) {
  const publicKeyJwk = request.payload?.crypto?.ecdhPublicKey;
  if (!publicKeyJwk) return result;
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
  const plaintext = new TextEncoder().encode(JSON.stringify(result));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  const agentPublicJwk = await subtle.exportKey("jwk", keyPair.publicKey);
  return {
    encrypted: true,
    alg: "ECDH-P-256+A256GCM",
    ecdhPublicKey: base64UrlEncode(JSON.stringify(agentPublicJwk)),
    iv: base64UrlEncodeBytes(iv),
    ciphertext: base64UrlEncodeBytes(new Uint8Array(ciphertext)),
  };
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
