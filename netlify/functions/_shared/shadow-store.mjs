import { getStore } from "@netlify/blobs";
import { readFileSync } from "node:fs";

export const STORE_NAME = "clinical-shadow";
const SHADOW_LOCAL_SECRETS = readLocalSecrets();

export function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export function env(name, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || SHADOW_LOCAL_SECRETS[name] || fallback;
}

function readLocalSecrets() {
  try {
    return JSON.parse(readFileSync(new URL("./shadow-local-secrets.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
}

export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function methodNotAllowed() {
  return json({ error: "method_not_allowed" }, 405);
}

export function requirePin(req, body = {}) {
  const expected = env("SHADOW_PIN");
  if (!expected) return false;
  const actual = req.headers.get("x-shadow-pin") || body.pin || "";
  return actual === expected;
}

export function requireRelayKey(req) {
  const expected = env("SHADOW_RELAY_KEY");
  if (!expected) return false;
  return req.headers.get("x-relay-key") === expected;
}

export function ttlMs() {
  return Number(env("SHADOW_TTL_MS", String(15 * 60 * 1000)));
}

export function isExpired(item, now = Date.now()) {
  return Number(item?.expiresAt || 0) <= now;
}

export function publicRequest(item) {
  return {
    id: item.id,
    type: item.type,
    payload: item.payload,
    status: item.status,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}
