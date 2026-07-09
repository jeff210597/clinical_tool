import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRelayUser, patientRoundingSummary, physicianRosterSummary } from "../services/relay_summary.mjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const DISCORD_API = "https://discord.com/api/v10";

await loadEnvFile(new URL("../.env", import.meta.url));
await loadEnvFile(new URL("../../.env", import.meta.url));

const config = {
  token: process.env.DISCORD_BOT_TOKEN || "",
  clientId: process.env.DISCORD_CLIENT_ID || "",
  guildId: process.env.DISCORD_GUILD_ID || "",
  channelId: process.env.DISCORD_CHANNEL_ID || "",
  allowedUsers: csvSet(process.env.DISCORD_ALLOWED_USER_IDS || ""),
  responseMode: process.env.RELAY_RESPONSE_MODE || "ephemeral",
};

if (process.argv.includes("--check-config")) {
  validateConfig();
  const user = await getRelayUser();
  console.log(`Discord relay config OK. Onepage session user: ${user.displayName || user.username || "unknown"}`);
  process.exit(0);
}

validateConfig();
await registerCommands();
await connectGateway();

async function registerCommands() {
  const commands = [
    {
      name: "ward",
      description: "查醫師住院清單",
      type: 1,
      options: [{ name: "doctor_id", description: "醫師員編/GSM", type: 3, required: true }],
    },
    {
      name: "summary",
      description: "查病人查房摘要",
      type: 1,
      options: [{ name: "query", description: "病歷號、床號或住院序號", type: 3, required: true }],
    },
    {
      name: "relay-health",
      description: "檢查院內 relay 與 Onepage session 狀態",
      type: 1,
    },
  ];
  await discordFetch(`/applications/${config.clientId}/guilds/${config.guildId}/commands`, {
    method: "PUT",
    body: JSON.stringify(commands),
  });
}

async function connectGateway() {
  const gateway = await discordFetch("/gateway/bot");
  const ws = new WebSocket(`${gateway.url}/?v=10&encoding=json`);
  let heartbeatTimer = null;
  let sequence = null;

  ws.addEventListener("message", async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.s !== null && payload.s !== undefined) sequence = payload.s;

    if (payload.op === 10) {
      heartbeatTimer = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: sequence }));
      }, payload.d.heartbeat_interval);
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: config.token,
          intents: 0,
          properties: { os: "windows", browser: "clinical-relay", device: "clinical-relay" },
        },
      }));
      return;
    }

    if (payload.op === 0 && payload.t === "READY") {
      console.log(`Clinical Discord relay ready as ${payload.d.user.username}. App dir: ${appDir}`);
      return;
    }

    if (payload.op === 0 && payload.t === "INTERACTION_CREATE") {
      await handleInteraction(payload.d).catch((error) => console.error(`interaction error: ${error.message}`));
    }
  });

  ws.addEventListener("close", () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    console.error("Discord gateway closed. Restarting relay agent is recommended.");
    process.exitCode = 1;
  });

  ws.addEventListener("error", (event) => {
    console.error(`Discord gateway error: ${event.message || "unknown"}`);
  });
}

async function handleInteraction(interaction) {
  if (interaction.type !== 2) return;
  const authError = authorizationError(interaction);
  const ephemeral = config.responseMode !== "channel";

  if (authError) {
    await interactionCallback(interaction, { type: 4, data: { content: authError, flags: 64 } });
    return;
  }

  await interactionCallback(interaction, { type: 5, data: ephemeral ? { flags: 64 } : {} });

  try {
    if (interaction.data.name === "ward") {
      const doctorId = optionValue(interaction, "doctor_id");
      const { text } = await physicianRosterSummary(doctorId);
      await sendLongReply(interaction, text, ephemeral);
      return;
    }

    if (interaction.data.name === "summary") {
      const query = optionValue(interaction, "query");
      const { text } = await patientRoundingSummary(query);
      await sendLongReply(interaction, text, ephemeral);
      return;
    }

    if (interaction.data.name === "relay-health") {
      const user = await getRelayUser();
      await sendLongReply(interaction, `Relay 正常。Onepage session：${user.displayName || user.username || "unknown"}`, ephemeral);
    }
  } catch (error) {
    await editOriginal(interaction, redactError(error));
  }
}

function authorizationError(interaction) {
  if (config.channelId && interaction.channel_id !== config.channelId) {
    return "這個 relay 只能在指定的私人頻道使用。";
  }
  const userId = interaction.member?.user?.id || interaction.user?.id || "";
  if (config.allowedUsers.size && !config.allowedUsers.has(userId)) {
    return "此 Discord 帳號不在 relay allowlist。";
  }
  return "";
}

async function sendLongReply(interaction, text, ephemeral) {
  const chunks = chunkText(text || "沒有資料。", 1850);
  await editOriginal(interaction, chunks[0]);
  for (const chunk of chunks.slice(1)) {
    await followUp(interaction, chunk, ephemeral);
  }
}

async function interactionCallback(interaction, body) {
  await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    auth: false,
    body: JSON.stringify(body),
  });
}

async function editOriginal(interaction, content) {
  await discordFetch(`/webhooks/${config.clientId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    auth: false,
    body: JSON.stringify({ content }),
  });
}

async function followUp(interaction, content, ephemeral) {
  await discordFetch(`/webhooks/${config.clientId}/${interaction.token}`, {
    method: "POST",
    auth: false,
    body: JSON.stringify({ content, flags: ephemeral ? 64 : 0 }),
  });
}

async function discordFetch(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.auth === false ? {} : { authorization: `Bot ${config.token}` }),
    ...(options.headers || {}),
  };
  const response = await fetch(`${DISCORD_API}${path}`, { ...options, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Discord HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function optionValue(interaction, name) {
  const option = (interaction.data?.options || []).find((item) => item.name === name);
  return String(option?.value || "").trim();
}

function chunkText(text, maxLength) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining.length > maxLength) {
    let index = remaining.lastIndexOf("\n", maxLength);
    if (index < 200) index = maxLength;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  chunks.push(remaining.trim() || "沒有資料。");
  return chunks;
}

function redactError(error) {
  const text = String(error?.message || error || "unknown error");
  return `Relay 查詢失敗：${text.replace(/[A-Za-z0-9_\-.]{24,}/g, "[redacted]")}`;
}

function validateConfig() {
  const missing = [];
  if (!config.token) missing.push("DISCORD_BOT_TOKEN");
  if (!config.clientId) missing.push("DISCORD_CLIENT_ID");
  if (!config.guildId) missing.push("DISCORD_GUILD_ID");
  if (!config.channelId) missing.push("DISCORD_CHANNEL_ID");
  if (missing.length) {
    throw new Error(`Discord relay missing env: ${missing.join(", ")}`);
  }
}

function csvSet(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
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
