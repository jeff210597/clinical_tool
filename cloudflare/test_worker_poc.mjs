import worker from "./worker.mjs";

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

let env = null;

async function request(method, url, options = {}) {
  const init = { method, headers: options.headers || {} };
  if (options.body) {
    init.headers = { "content-type": "application/json", ...init.headers };
    init.body = JSON.stringify(options.body);
  }
  const response = await worker.fetch(new Request(url, init), env);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${url} failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

class MemoryStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = normalizeSql(sql);
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  async run() {
    if (this.sql.startsWith("insert into cf_shadow_requests")) {
      const [id, type, payloadJson, status, createdAt, expiresAt] = this.bindings;
      this.db.rows.set(id, {
        id,
        type,
        payload_json: payloadJson,
        status,
        result_json: null,
        error: "",
        created_at: createdAt,
        claimed_at: "",
        completed_at: "",
        expires_at: expiresAt,
      });
      return { success: true };
    }
    if (this.sql.startsWith("update cf_shadow_requests set status = 'claimed'")) {
      const [claimedAt, id] = this.bindings;
      const row = this.db.rows.get(id);
      if (row) Object.assign(row, { status: "claimed", claimed_at: claimedAt });
      return { success: true };
    }
    if (this.sql.startsWith("update cf_shadow_requests set status = ?")) {
      const [status, resultJson, error, completedAt, id] = this.bindings;
      const row = this.db.rows.get(id);
      if (row) Object.assign(row, { status, result_json: resultJson, error, completed_at: completedAt });
      return { success: true };
    }
    if (this.sql.startsWith("delete from cf_shadow_requests")) {
      const [expiresAt] = this.bindings;
      for (const [id, row] of this.db.rows) {
        if (row.expires_at <= expiresAt) this.db.rows.delete(id);
      }
      return { success: true };
    }
    throw new Error(`Unsupported SQL in test: ${this.sql}`);
  }

  async first() {
    if (this.sql.startsWith("select * from cf_shadow_requests where id = ?")) {
      return this.db.rows.get(this.bindings[0]) || null;
    }
    throw new Error(`Unsupported first SQL in test: ${this.sql}`);
  }

  async all() {
    if (this.sql.includes("where status = 'pending'")) {
      const now = this.bindings[0];
      const results = [...this.db.rows.values()]
        .filter((row) => row.status === "pending" && row.expires_at > now)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, 5);
      return { results };
    }
    throw new Error(`Unsupported all SQL in test: ${this.sql}`);
  }
}

class MemoryD1 {
  constructor() {
    this.rows = new Map();
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
}

env = {
  CF_SHADOW_PIN: "123456",
  CF_SHADOW_RELAY_KEY: "relay-key-for-test",
  CF_SHADOW_TTL_SECONDS: "600",
  DB: new MemoryD1(),
};

await request("GET", "https://example.test/health");
const created = await request("POST", "https://example.test/api/cf-shadow/request", {
  headers: { "x-shadow-pin": env.CF_SHADOW_PIN },
  body: { type: "echo", payload: { text: "hello" } },
});
const pending = await request("GET", "https://example.test/api/cf-shadow/agent/poll", {
  headers: { "x-relay-key": env.CF_SHADOW_RELAY_KEY },
});
if (pending.requests.length !== 1 || pending.requests[0].id !== created.id) throw new Error("poll did not return created request");

await request("POST", "https://example.test/api/cf-shadow/agent/respond", {
  headers: { "x-relay-key": env.CF_SHADOW_RELAY_KEY },
  body: { id: created.id, status: "done", result: { ok: true } },
});
const result = await request("GET", `https://example.test/api/cf-shadow/result/${created.id}?pin=${env.CF_SHADOW_PIN}`);
if (result.status !== "done" || result.result?.ok !== true) throw new Error("result did not round-trip");

const refresh = await request("POST", "https://example.test/api/cf-shadow/request", {
  headers: { "x-shadow-pin": env.CF_SHADOW_PIN },
  body: { type: "session_refresh", payload: { crypto: { ecdhPublicKey: "a".repeat(120) } } },
});
const refreshPoll = await request("GET", "https://example.test/api/cf-shadow/agent/poll", {
  headers: { "x-relay-key": env.CF_SHADOW_RELAY_KEY },
});
const refreshRequest = refreshPoll.requests.find((item) => item.id === refresh.id);
if (!refreshRequest || refreshRequest.type !== "session_refresh" || "username" in refreshRequest.payload || "password" in refreshRequest.payload) {
  throw new Error("session_refresh mailbox request was not safely normalized");
}
console.log("Cloudflare POC worker smoke test OK");
