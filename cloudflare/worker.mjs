const DEFAULT_TTL_SECONDS = 600;
const MAX_RESULT_BYTES = 512 * 1024;

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return json({ error: "server_error", message: redact(error?.message || error) }, 500);
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "clinical-tool-cloudflare-shadow", time: new Date().toISOString() });
  }

  if (url.pathname === "/api/cf-shadow/request" && request.method === "POST") return createRequest(request, env);
  if (url.pathname.startsWith("/api/cf-shadow/result/") && request.method === "GET") return readResult(request, env);
  if (url.pathname === "/api/cf-shadow/agent/poll" && request.method === "GET") return pollRequests(request, env);
  if (url.pathname === "/api/cf-shadow/agent/respond" && request.method === "POST") return postResult(request, env);

  return json({ error: "not_found" }, 404);
}

async function createRequest(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!requirePin(request, body, env)) return json({ error: "unauthorized" }, 401);
  const type = String(body.type || "").trim();
  const payload = normalizePayload(type, body.payload || {});
  if (!payload) return json({ error: "bad_request", message: "Unsupported or incomplete request." }, 400);

  const now = Date.now();
  const ttlSeconds = Number(env.CF_SHADOW_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  const item = {
    id: crypto.randomUUID(),
    type,
    payload,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };

  await exec(env, `INSERT INTO cf_shadow_requests
    (id, type, payload_json, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    item.id,
    item.type,
    JSON.stringify(item.payload),
    item.status,
    item.createdAt,
    item.expiresAt,
  );

  return json({ id: item.id, status: item.status, expiresAt: item.expiresAt });
}

async function readResult(request, env) {
  const url = new URL(request.url);
  const id = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
  if (!id) return json({ error: "bad_request", message: "Missing request id." }, 400);
  if (!requirePin(request, { pin: url.searchParams.get("pin") || "" }, env)) return json({ error: "unauthorized" }, 401);

  await cleanupExpired(env);
  const row = await first(env, `SELECT * FROM cf_shadow_requests WHERE id = ?`, id);
  if (!row) return json({ error: "not_found" }, 404);
  if (isExpired(row)) return json({ id, status: "expired" }, 410);

  return json(publicRow(row, { includeResult: true }));
}

async function pollRequests(request, env) {
  if (!requireRelayKey(request, env)) return json({ error: "unauthorized" }, 401);
  await cleanupExpired(env);
  const rows = await all(env, `
    SELECT * FROM cf_shadow_requests
    WHERE status = 'pending' AND expires_at > ?
    ORDER BY created_at ASC
    LIMIT 5
  `, new Date().toISOString());

  const claimedAt = new Date().toISOString();
  for (const row of rows) {
    await exec(env, `UPDATE cf_shadow_requests SET status = 'claimed', claimed_at = ? WHERE id = ?`, claimedAt, row.id);
  }

  return json({ count: rows.length, requests: rows.map((row) => publicRow({ ...row, status: "claimed", claimed_at: claimedAt })) });
}

async function postResult(request, env) {
  if (!requireRelayKey(request, env)) return json({ error: "unauthorized" }, 401);
  const raw = await request.text();
  if (raw.length > MAX_RESULT_BYTES) return json({ error: "payload_too_large" }, 413);
  const body = raw ? JSON.parse(raw) : {};
  const id = String(body.id || "").trim();
  if (!id) return json({ error: "bad_request", message: "Missing request id." }, 400);

  const row = await first(env, `SELECT * FROM cf_shadow_requests WHERE id = ?`, id);
  if (!row) return json({ error: "not_found" }, 404);
  if (isExpired(row)) return json({ id, status: "expired" }, 410);

  const status = body.status === "error" ? "error" : "done";
  const completedAt = new Date().toISOString();
  await exec(env, `
    UPDATE cf_shadow_requests
    SET status = ?, result_json = ?, error = ?, completed_at = ?
    WHERE id = ?
  `, status, JSON.stringify(body.result || null), String(body.error || ""), completedAt, id);

  return json({ ok: true, id, status });
}

function normalizePayload(type, payload) {
  if (type === "ward") {
    const doctorId = String(payload.doctorId || payload.doctor_id || "").trim();
    return doctorId ? { doctorId } : null;
  }
  if (type === "summary") {
    const query = String(payload.query || "").trim();
    return query ? { query } : null;
  }
  if (type === "echo") {
    return { text: String(payload.text || "ping").slice(0, 200) };
  }
  return null;
}

function publicRow(row, options = {}) {
  const out = {
    id: row.id,
    type: row.type,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    createdAt: row.created_at,
    claimedAt: row.claimed_at || "",
    completedAt: row.completed_at || "",
    expiresAt: row.expires_at,
  };
  if (options.includeResult) {
    out.result = parseJson(row.result_json, null);
    out.error = row.error || "";
  }
  return out;
}

async function cleanupExpired(env) {
  await exec(env, `DELETE FROM cf_shadow_requests WHERE expires_at <= ?`, new Date().toISOString());
}

function requirePin(request, body, env) {
  const expected = String(env.CF_SHADOW_PIN || "").trim();
  if (!expected) return false;
  const actual = String(request.headers.get("x-shadow-pin") || body.pin || "").trim();
  return safeEqual(actual, expected);
}

function requireRelayKey(request, env) {
  const expected = String(env.CF_SHADOW_RELAY_KEY || "").trim();
  if (!expected) return false;
  const actual = String(request.headers.get("x-relay-key") || "").trim();
  return safeEqual(actual, expected);
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function exec(env, sql, ...bindings) {
  return env.DB.prepare(sql).bind(...bindings).run();
}

async function first(env, sql, ...bindings) {
  return env.DB.prepare(sql).bind(...bindings).first();
}

async function all(env, sql, ...bindings) {
  const result = await env.DB.prepare(sql).bind(...bindings).all();
  return result.results || [];
}

function isExpired(row) {
  return new Date(row.expires_at).getTime() <= Date.now();
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function json(payload, status = 200) {
  return cors(new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  }));
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,x-shadow-pin,x-relay-key");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redact(value) {
  return String(value || "").replace(/[A-Za-z0-9_\-.]{24,}/g, "[redacted]");
}
