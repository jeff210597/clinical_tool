# Restore From GitHub

This repository intentionally excludes local secrets and runtime cache. A new host can restore the workstation from GitHub plus the values listed below.

## Clone

```powershell
git clone https://github.com/jeff210597/clinical_tool.git
cd clinical_tool
```

## Local Files To Recreate

Create `app/.env` from `app/.env.example`.

Required for Discord relay:

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_CHANNEL_ID=
DISCORD_ALLOWED_USER_IDS=
RELAY_RESPONSE_MODE=ephemeral
```

Required for shadow workstation:

```env
SHADOW_API_BASE=https://clinical-tool-shadow.netlify.app
SHADOW_RELAY_KEY=
SHADOW_PIN=
SHADOW_POLL_INTERVAL_MS=3000
CF_SHADOW_API_BASE=https://data-viewer.workspace4829.workers.dev
CF_SHADOW_RELAY_KEY=
CF_SHADOW_PIN=
CF_SHADOW_POLL_INTERVAL_MS=3000
```

Values that must be provided manually:

- Discord bot token
- Discord client/application id
- Discord guild/server id
- Discord channel id
- Allowed Discord user ids
- Shadow relay key
- Shadow PIN
- Netlify site URL, if it changes
- Netlify personal access token, only when redeploying from the new host
- Cloudflare API token and account id, only when redeploying the Cloudflare Worker from the new host
- Cloudflare Worker URL, relay key, and PIN
- GitHub token, only when pushing updates from the new host

Do not commit these files:

- `app/.env`
- `app/.local/`
- `PAT token.txt`
- `netlify token.txt`
- `cloudflare token.txt`
- `cloudflare/wrangler.toml`
- `netlify/functions/_shared/shadow-local-secrets.json`

## Start LAN Workstation

```powershell
.\Start_Workbench_LAN.cmd
```

LAN URL:

```text
http://10.97.6.34:8766/
```

The IP may change on another host. Use the IP printed by `Start_Workbench_LAN.cmd`.

## Start Discord Relay

```powershell
.\Start_Discord_Relay_Agent.cmd
```

Test in Discord:

```text
/relay-health
/ward doctor_id:09432
/summary query:01585357
```

## Start Shadow Relay

```powershell
.\Start_Shadow_Relay_Agent.cmd
```

Netlify shadow workstation:

```text
https://clinical-tool-shadow.netlify.app
```

Enter `SHADOW_PIN` in the web page, then query a physician id or patient chart number.

## Start Cloudflare Shadow Relay

```powershell
.\Start_Cloudflare_Relay_Agent.cmd
```

Cloudflare shadow workstation:

```text
https://data-viewer.workspace4829.workers.dev
```

Enter `CF_SHADOW_PIN` in the web page, then query a physician id or patient chart number. This path does not require Netlify.

## Redeploy Netlify Shadow Site

If the Netlify site needs redeployment, provide a Netlify personal access token locally in `netlify token.txt`, then deploy with the current source package and Netlify API flow.

The committed files contain the shadow UI and functions, but not the embedded local secret fallback file. For production, prefer Netlify environment variables:

- `SHADOW_PIN`
- `SHADOW_RELAY_KEY`
- `SHADOW_TTL_MS=900000`

If Netlify env-var setup is unavailable, regenerate `netlify/functions/_shared/shadow-local-secrets.json` locally from `app/.env` before deploy. This file is intentionally ignored by Git.
