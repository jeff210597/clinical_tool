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
  if (request.method === "GET" && url.pathname === "/") return html(pocHtml());
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "clinical-tool-cloudflare-shadow", time: new Date().toISOString() });
  }

  if (url.pathname === "/api/cf-shadow/request" && request.method === "POST") return createRequest(request, env);
  if (url.pathname.startsWith("/api/cf-shadow/result/") && request.method === "GET") return readResult(request, env);
  if (url.pathname === "/api/shadow/request" && request.method === "POST") return createRequest(request, env);
  if (url.pathname.startsWith("/api/shadow/result/") && request.method === "GET") return readResult(request, env);
  if (url.pathname === "/api/cf-shadow/agent/poll" && request.method === "GET") return pollRequests(request, env);
  if (url.pathname === "/api/cf-shadow/agent/respond" && request.method === "POST") return postResult(request, env);

  if (env.ASSETS && request.method === "GET") return env.ASSETS.fetch(request);

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
  const crypto = normalizeCrypto(payload.crypto);
  if (type === "ward") {
    const doctorId = String(payload.doctorId || payload.doctor_id || "").trim();
    return doctorId ? { doctorId, ...(crypto ? { crypto } : {}) } : null;
  }
  if (type === "summary") {
    const query = String(payload.query || "").trim();
    return query ? { query, ...(crypto ? { crypto } : {}) } : null;
  }
  if (type === "echo") {
    return { text: String(payload.text || "ping").slice(0, 200), ...(crypto ? { crypto } : {}) };
  }
  return null;
}

function normalizeCrypto(cryptoPayload) {
  const publicKey = String(cryptoPayload?.ecdhPublicKey || "").trim();
  if (!publicKey || publicKey.length > 300) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) return null;
  return { alg: "ECDH-P-256+A256GCM", ecdhPublicKey: publicKey };
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

function html(markup, status = 200) {
  return cors(new Response(markup, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
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

function pocHtml() {
  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clinical Tool Cloudflare POC</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f6f8fb; color: #172033; }
      main { max-width: 920px; margin: 0 auto; padding: 24px; }
      .card { background: #fff; border: 1px solid #dfe7ef; border-radius: 10px; padding: 18px; margin: 14px 0; }
      label { display: block; font-size: 13px; color: #5b677a; margin: 10px 0 4px; }
      input, select, button { font: inherit; }
      input, select { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; }
      button { border: 0; border-radius: 8px; padding: 10px 14px; background: #047d76; color: #fff; font-weight: 700; }
      button:disabled { opacity: .55; }
      pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 14px; }
      .result-text { white-space: pre-wrap; word-break: break-word; border: 1px solid #dbe5ef; border-radius: 8px; background: #fbfdff; padding: 14px; line-height: 1.55; }
      details { margin-top: 12px; }
      summary { cursor: pointer; color: #047d76; font-weight: 700; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .note { color: #64748b; font-size: 13px; line-height: 1.5; }
      @media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Cloudflare 影子工作站 POC</h1>
      <p class="note">這個頁面只測試 Cloudflare mailbox。院內端必須主動輪詢 Cloudflare；本頁不會，也不能，直接連回院內電腦。</p>
      <section class="card">
        <div class="row">
          <div><label for="apiBase">Worker API URL</label><input id="apiBase" /></div>
          <div><label for="pin">PIN</label><input id="pin" type="password" autocomplete="off" /></div>
        </div>
        <label for="type">Request type</label>
        <select id="type">
          <option value="echo">echo 測試，不抓病人資料</option>
          <option value="summary">病人摘要</option>
          <option value="ward">醫師住院清單</option>
        </select>
        <label for="query">查詢內容</label>
        <input id="query" placeholder="echo 文字 / 病歷號 / 醫師員編" />
        <p><button id="send">送出測試 request</button></p>
      </section>
      <section class="card">
        <h2>狀態</h2>
        <div id="resultText" class="result-text">尚未送出。</div>
        <details>
          <summary>原始除錯 JSON</summary>
          <pre id="status">尚未送出。</pre>
        </details>
      </section>
    </main>
    <script>
      const $ = (id) => document.querySelector(id);
      const apiBase = $("#apiBase"), pin = $("#pin"), type = $("#type"), query = $("#query"), statusBox = $("#status"), resultText = $("#resultText"), send = $("#send");
      apiBase.value = localStorage.getItem("cfShadowApiBase") || location.origin;
      pin.value = localStorage.getItem("cfShadowPin") || "";
      send.addEventListener("click", async () => {
        send.disabled = true;
        try {
          localStorage.setItem("cfShadowApiBase", apiBase.value.trim());
          localStorage.setItem("cfShadowPin", pin.value);
          const cryptoState = await createCryptoState();
          const payload = type.value === "ward" ? { doctorId: query.value.trim() } : type.value === "summary" ? { query: query.value.trim() } : { text: query.value.trim() || "hello from cloudflare poc" };
          payload.crypto = { ecdhPublicKey: cryptoState.publicKey };
          setStatus({ step: "creating", payload }, "已送出請求，等待院內主機回覆...");
          const created = await post("/api/cf-shadow/request", { type: type.value, payload, pin: pin.value });
          setStatus({ step: "created", created }, "請求已建立，等待院內主機領取...");
          for (let i = 0; i < 40; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const result = await get("/api/cf-shadow/result/" + encodeURIComponent(created.id) + "?pin=" + encodeURIComponent(pin.value));
            const decryptedResult = await decryptResultIfNeeded(result.result, cryptoState.privateKey);
            setStatus({ step: "poll", attempt: i + 1, result: compactDebugResult(result), decryptedResult }, formatReadableResult(result, decryptedResult));
            if (["done", "error", "expired"].includes(result.status)) break;
          }
        } catch (error) {
          setStatus({ error: error.message || String(error) }, "錯誤：" + (error.message || String(error)));
        } finally {
          send.disabled = false;
        }
      });
      async function post(path, body) {
        const response = await fetch(apiBase.value.replace(/\\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json", "x-shadow-pin": pin.value }, body: JSON.stringify(body) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || "HTTP " + response.status);
        return payload;
      }
      async function get(path) {
        const response = await fetch(apiBase.value.replace(/\\/$/, "") + path, { headers: { "x-shadow-pin": pin.value } });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 410) throw new Error(payload.message || payload.error || "HTTP " + response.status);
        return payload;
      }
      async function createCryptoState() {
        const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
        const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
        return { privateKey: keyPair.privateKey, publicKey: base64UrlEncode(JSON.stringify(publicJwk)) };
      }
      async function decryptResultIfNeeded(result, privateKey) {
        if (!result || result.encrypted !== true) return result;
        const peerPublicKey = await crypto.subtle.importKey("jwk", JSON.parse(base64UrlDecode(result.ecdhPublicKey)), { name: "ECDH", namedCurve: "P-256" }, false, []);
        const aesKey = await crypto.subtle.deriveKey({ name: "ECDH", public: peerPublicKey }, privateKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(result.iv) }, aesKey, base64UrlToBytes(result.ciphertext));
        return JSON.parse(new TextDecoder().decode(plaintext));
      }
      function base64UrlEncode(value) {
        const bytes = new TextEncoder().encode(value);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
      }
      function base64UrlDecode(value) {
        const bytes = base64UrlToBytes(value);
        return new TextDecoder().decode(bytes);
      }
      function base64UrlToBytes(value) {
        const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
        const binary = atob(padded);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      }
      function compactDebugResult(result) {
        if (!result?.result?.encrypted) return result;
        return {
          ...result,
          result: {
            encrypted: true,
            alg: result.result.alg,
            ecdhPublicKeyLength: result.result.ecdhPublicKey?.length || 0,
            ivLength: result.result.iv?.length || 0,
            ciphertextLength: result.result.ciphertext?.length || 0,
          },
        };
      }
      function formatReadableResult(result, decryptedResult) {
        if (!result) return "等待回覆...";
        if (result.status === "pending" || result.status === "claimed") return "等待院內主機回覆...（" + result.status + "）";
        if (result.status === "expired") return "請求已過期，請重新送出。";
        if (decryptedResult?.error) return "錯誤：" + decryptedResult.error;
        if (result.status === "error") return "錯誤：" + (result.error || "查詢失敗");
        if (!decryptedResult) return "已完成，但沒有可顯示內容。";
        if (typeof decryptedResult === "string") return decryptedResult;
        if (decryptedResult.text) return decryptedResult.text;
        if (decryptedResult.echo) return "Echo 回覆：" + decryptedResult.echo;
        return JSON.stringify(decryptedResult, null, 2);
      }
      function setStatus(value, readable) {
        statusBox.textContent = JSON.stringify(value, null, 2);
        resultText.textContent = readable || JSON.stringify(value, null, 2);
      }
    </script>
  </body>
</html>`;
}
