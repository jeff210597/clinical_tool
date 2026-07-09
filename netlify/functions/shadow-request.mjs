import { randomUUID } from "node:crypto";
import { json, methodNotAllowed, requirePin, store, ttlMs } from "./_shared/shadow-store.mjs";

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();

  const body = await req.json().catch(() => ({}));
  if (!requirePin(req, body)) return json({ error: "unauthorized" }, 401);

  const type = String(body.type || "").trim();
  const payload = normalizePayload(type, body.payload || {});
  if (!payload) return json({ error: "bad_request", message: "Unsupported or incomplete shadow request." }, 400);

  const now = Date.now();
  const item = {
    id: randomUUID(),
    type,
    payload,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    expiresAt: now + ttlMs(),
  };

  await store().setJSON(`requests/${item.id}`, item);
  return json({ id: item.id, status: item.status, expiresAt: item.expiresAt });
};

export const config = {
  path: "/api/shadow/request",
  method: ["POST"],
};

function normalizePayload(type, payload) {
  if (type === "ward") {
    const doctorId = String(payload.doctorId || payload.doctor_id || "").trim();
    return doctorId ? { doctorId } : null;
  }
  if (type === "summary") {
    const query = String(payload.query || "").trim();
    return query ? { query } : null;
  }
  return null;
}
