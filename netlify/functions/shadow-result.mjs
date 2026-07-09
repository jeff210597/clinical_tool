import { isExpired, json, methodNotAllowed, requirePin, requireRelayKey, store } from "./_shared/shadow-store.mjs";

export default async (req, context) => {
  if (req.method === "POST") return handlePost(req);
  if (req.method === "GET") return handleGet(req, context.params.id);
  return methodNotAllowed();
};

export const config = {
  path: ["/api/shadow/result", "/api/shadow/result/:id"],
  method: ["GET", "POST"],
};

async function handlePost(req) {
  if (!requireRelayKey(req)) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "").trim();
  if (!id) return json({ error: "bad_request", message: "Missing request id." }, 400);

  const s = store();
  const request = await s.get(`requests/${id}`, { type: "json" });
  if (!request) return json({ error: "not_found" }, 404);

  const now = Date.now();
  const result = {
    id,
    status: body.status === "error" ? "error" : "done",
    result: body.result || null,
    error: body.error || "",
    completedAt: new Date(now).toISOString(),
    expiresAt: request.expiresAt,
  };
  await s.setJSON(`results/${id}`, result);
  await s.setJSON(`requests/${id}`, { ...request, status: result.status, completedAt: result.completedAt });
  return json({ ok: true });
}

async function handleGet(req, id) {
  const url = new URL(req.url);
  const body = { pin: url.searchParams.get("pin") || "" };
  if (!requirePin(req, body)) return json({ error: "unauthorized" }, 401);

  const requestId = String(id || "").trim();
  if (!requestId) return json({ error: "bad_request", message: "Missing request id." }, 400);

  const s = store();
  const request = await s.get(`requests/${requestId}`, { type: "json" });
  if (!request) return json({ error: "not_found" }, 404);
  if (isExpired(request)) {
    await s.delete(`requests/${requestId}`);
    await s.delete(`results/${requestId}`);
    return json({ status: "expired", id: requestId }, 410);
  }

  const result = await s.get(`results/${requestId}`, { type: "json" });
  if (!result) {
    return json({ id: requestId, status: request.status || "pending", request: { type: request.type, payload: request.payload } });
  }
  return json(result);
}
