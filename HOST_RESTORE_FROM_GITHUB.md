# Restore From GitHub

This repository intentionally excludes local secrets and runtime cache. A new host can restore the workstation from GitHub plus the values listed below.

## Clone

```powershell
git clone https://github.com/jeff210597/clinical_tool.git
cd clinical_tool
```

## Local Files To Recreate

Create `app/.env` from `app/.env.example`.

Required for the current Cloudflare shadow workstation:

```env
CF_SHADOW_API_BASE=https://data-viewer.workspace4829.workers.dev
CF_SHADOW_RELAY_KEY=
CF_SHADOW_PIN=
CF_SHADOW_POLL_INTERVAL_MS=1500
```

`CF_SHADOW_POLL_INTERVAL_MS=1500` is the current approved setting. It only
controls outbound HTTPS mailbox polling to Cloudflare and does not increase
Onepage/NIS fetches unless a user requests new data.

The Netlify and Discord relay settings in `app/.env.example` are optional
legacy fallbacks; they are not required for the current workstation.

Values that must be provided manually:

- Cloudflare Worker relay key and PIN
- Cloudflare API token and account id, only when redeploying the Cloudflare Worker from the new host
- Cloudflare Worker URL, relay key, and PIN
- GitHub token, only when pushing updates from the new host

Node.js 20 or newer is required. After cloning, restore dependencies with:

```powershell
npm ci
Push-Location app
npm ci
Pop-Location
```

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

## Keep LAN Workstation Running

To make the LAN workstation recover automatically after login or after the
local Node process stops, install the local watchdog:

```powershell
.\Install_Workbench_Autostart.cmd
```

What it does:

- Checks `http://127.0.0.1:8766/api/health`.
- Starts `app/server.mjs` on `0.0.0.0:8766` when the service is down.
- Rechecks every 5 minutes after Windows login.
- Writes local status to `app/.local/workbench_watchdog.log`.

What it does not do:

- It does not change Windows Firewall rules.
- It does not create VPN, tunnel, reverse proxy, or routing rules.
- It does not expose the workstation outside the network by itself.

If Windows allows task registration, the installer uses Task Scheduler. If that
is denied, it falls back to a per-user Startup shortcut:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Clinical Tool Workbench Watchdog.lnk
```

## Start Cloudflare Shadow Relay

```powershell
.\Start_Cloudflare_Relay_Agent.cmd
```

Cloudflare shadow workstation:

```text
https://data-viewer.workspace4829.workers.dev
```

Enter `CF_SHADOW_PIN` in the web page, then query a physician id or patient chart number. This path does not require Netlify.

To keep the Cloudflare relay in the background and recover it automatically
after sign-in or a process stop, run once:

```powershell
.\scripts\Install_Cloudflare_Relay_Autostart.ps1
```

This installer creates a per-user background watchdog. It does not create an
inbound listener, modify firewall rules, or create a tunnel.

## Redeploy Netlify Shadow Site

If the Netlify site needs redeployment, provide a Netlify personal access token locally in `netlify token.txt`, then deploy with the current source package and Netlify API flow.

The committed files contain the shadow UI and functions, but not the embedded local secret fallback file. For production, prefer Netlify environment variables:

- `SHADOW_PIN`
- `SHADOW_RELAY_KEY`
- `SHADOW_TTL_MS=900000`

If Netlify env-var setup is unavailable, regenerate `netlify/functions/_shared/shadow-local-secrets.json` locally from `app/.env` before deploy. This file is intentionally ignored by Git.
