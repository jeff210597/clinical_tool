const base = process.env.SMOKE_BASE || "http://127.0.0.1:8766";

(async () => {
  const health = await fetch(`${base}/api/health`);
  if (!health.ok) throw new Error(`health failed: ${health.status}`);
  const healthJson = await health.json();
  if (!healthJson.ok) throw new Error("health did not return ok=true");

  const me = await fetch(`${base}/api/auth/me`);
  if (me.status !== 401) throw new Error(`expected auth/me 401 before login, got ${me.status}`);

  const search = await fetch(`${base}/api/patients/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "DEMO" }),
  });
  if (search.status !== 401) throw new Error(`expected search 401 before login, got ${search.status}`);

  console.log(JSON.stringify({ ok: true, service: healthJson.service, mode: healthJson.mode }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
