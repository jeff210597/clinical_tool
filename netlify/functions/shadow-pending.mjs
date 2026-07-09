import { isExpired, json, methodNotAllowed, publicRequest, requireRelayKey, store } from "./_shared/shadow-store.mjs";

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed();
  if (!requireRelayKey(req)) return json({ error: "unauthorized" }, 401);

  const s = store();
  const now = Date.now();
  const listed = await s.list({ prefix: "requests/" });
  const pending = [];

  for (const blob of listed.blobs || []) {
    const item = await s.get(blob.key, { type: "json" });
    if (!item) continue;
    if (isExpired(item, now)) {
      await s.delete(blob.key);
      await s.delete(`results/${item.id}`);
      continue;
    }
    if (item.status !== "pending") continue;
    const claimed = { ...item, status: "claimed", claimedAt: new Date(now).toISOString() };
    await s.setJSON(blob.key, claimed);
    pending.push(publicRequest(claimed));
  }

  return json({ requests: pending.slice(0, 5), count: pending.length });
};

export const config = {
  path: "/api/shadow/pending",
  method: ["GET"],
};
