import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { patientRoundingSummary, physicianRosterSummary } from "../services/relay_summary.mjs";

await loadEnvFile(new URL("../.env", import.meta.url));
await loadEnvFile(new URL("../../.env", import.meta.url));

const config = {
  apiBase: (process.env.SHADOW_API_BASE || "").replace(/\/$/, ""),
  relayKey: process.env.SHADOW_RELAY_KEY || "",
  intervalMs: Number(process.env.SHADOW_POLL_INTERVAL_MS || 3000),
};

if (process.argv.includes("--check-config")) {
  validateConfig();
  console.log(`Shadow relay config OK. API: ${config.apiBase}`);
  process.exit(0);
}

validateConfig();
console.log(`Shadow relay polling ${config.apiBase}`);

if (process.argv.includes("--once")) {
  await pollOnce();
  process.exit(0);
}

while (true) {
  try {
    await pollOnce();
  } catch (error) {
    console.error(`shadow poll error: ${redact(error.message || error)}`);
  }
  await sleep(config.intervalMs);
}

async function pollOnce() {
  const pending = await shadowFetch("/api/shadow/pending");
  const requests = pending.requests || [];
  for (const request of requests) {
    await processRequest(request);
  }
}

async function processRequest(request) {
  try {
    let result = null;
    if (request.type === "ward") {
      result = await physicianRosterSummary(request.payload?.doctorId);
    } else if (request.type === "summary") {
      result = await patientRoundingSummary(request.payload?.query);
    } else {
      throw new Error(`Unsupported request type: ${request.type}`);
    }
    await shadowFetch("/api/shadow/result", {
      method: "POST",
      body: JSON.stringify({ id: request.id, status: "done", result }),
    });
    console.log(`shadow request ${request.id} done (${request.type})`);
  } catch (error) {
    await shadowFetch("/api/shadow/result", {
      method: "POST",
      body: JSON.stringify({ id: request.id, status: "error", error: redact(error.message || error) }),
    }).catch((postError) => console.error(`failed posting error result: ${redact(postError.message || postError)}`));
    console.error(`shadow request ${request.id} failed: ${redact(error.message || error)}`);
  }
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
  if (!response.ok) throw new Error(payload.message || payload.error || `Shadow API ${response.status}`);
  return payload;
}

function validateConfig() {
  const missing = [];
  if (!config.apiBase) missing.push("SHADOW_API_BASE");
  if (!config.relayKey) missing.push("SHADOW_RELAY_KEY");
  if (missing.length) throw new Error(`Shadow relay missing env: ${missing.join(", ")}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value) {
  return String(value || "").replace(/[A-Za-z0-9_\-.]{24,}/g, "[redacted]");
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
