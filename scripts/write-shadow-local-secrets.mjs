import { mkdir, readFile, writeFile } from "node:fs/promises";

const env = await readEnv("app/.env");
const secrets = {
  SHADOW_PIN: env.SHADOW_PIN || "",
  SHADOW_RELAY_KEY: env.SHADOW_RELAY_KEY || "",
  SHADOW_TTL_MS: env.SHADOW_TTL_MS || "900000",
};

if (!secrets.SHADOW_PIN || !secrets.SHADOW_RELAY_KEY) {
  throw new Error("app/.env must contain SHADOW_PIN and SHADOW_RELAY_KEY");
}

await mkdir("netlify/functions/_shared", { recursive: true });
await writeFile("netlify/functions/_shared/shadow-local-secrets.json", `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
console.log("Wrote netlify/functions/_shared/shadow-local-secrets.json");

async function readEnv(path) {
  const raw = await readFile(path, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
}
