# Cloudflare Shadow Workstation

This workflow uses Cloudflare Workers as the public shadow workstation link and request/result mailbox.

It does **not** use Cloudflare Tunnel, WARP, Zero Trust remote access, reverse VPN, port forwarding, or any inbound connection to the hospital workstation.

## Network Boundary

Allowed flow:

```text
Phone browser -> Cloudflare Worker over HTTPS
Hospital workstation relay agent -> Cloudflare Worker over outbound HTTPS polling
Hospital workstation relay agent -> Onepage/NIS inside hospital network
```

Not used:

- No inbound listener on the hospital workstation.
- No public hospital workstation IP or port.
- No Cloudflare Tunnel.
- No firewall traversal from outside to inside.
- No remote desktop or remote shell.

The relay agent only makes normal outbound HTTPS requests to the configured Worker URL.

## Files

- `shadow/index.html`, `shadow/app.js`, `shadow/styles.css` - full shadow workstation UI served by Cloudflare Workers static assets.
- `cloudflare/worker.mjs` - Worker API mailbox and static-asset fallback.
- `cloudflare/schema.sql` - D1 schema.
- `cloudflare/pages/index.html` - minimal standalone test page, kept as a reference.
- `cloudflare/wrangler.toml.example` - deployment template.
- `app/relay/cloudflare_poll_agent.mjs` - hospital-side outbound polling agent.
- `Start_Cloudflare_Relay_Agent.cmd` - hospital-side relay starter.

## API

- `GET /health`
- `POST /api/shadow/request`
- `GET /api/shadow/result/:id`
- `POST /api/cf-shadow/request`
- `GET /api/cf-shadow/result/:id`
- `GET /api/cf-shadow/agent/poll`
- `POST /api/cf-shadow/agent/respond`

## Required Cloudflare Setup

Install and login to Wrangler, or provide a Cloudflare API token with permissions for Workers, Pages, and D1.

Create a D1 database:

```powershell
npx wrangler d1 create data-viewer
```

Copy `cloudflare/wrangler.toml.example` to `cloudflare/wrangler.toml` and fill `database_id`.

Apply schema:

```powershell
npx wrangler d1 execute data-viewer --remote --file cloudflare/schema.sql
```

Set secrets:

```powershell
npx wrangler secret put CF_SHADOW_PIN --config cloudflare/wrangler.toml
npx wrangler secret put CF_SHADOW_RELAY_KEY --config cloudflare/wrangler.toml
```

Deploy Worker:

```powershell
npx wrangler deploy --config cloudflare/wrangler.toml
```

Open the Worker URL directly to use the shadow workstation. Cloudflare Pages and Netlify are not required for this deployment path.

## Local Agent Configuration

Add to `app/.env`:

```text
CF_SHADOW_API_BASE=https://<your-worker>.<account>.workers.dev
CF_SHADOW_RELAY_KEY=<same as Worker secret>
CF_SHADOW_POLL_INTERVAL_MS=3000
```

Run the hospital-side outbound relay:

```powershell
Start_Cloudflare_Relay_Agent.cmd
```

Or:

```powershell
$node="$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node app\relay\cloudflare_poll_agent.mjs --check-config
& $node app\relay\cloudflare_poll_agent.mjs
```

For connection-only testing, run `cloudflare_poll_agent.mjs --echo-only`. Remove echo-only mode for real workstation queries.

## Safety Checklist Before Clinical Use

- Verify `GET /health` works from the hospital workstation.
- Verify an echo request/response works before clinical use.
- Confirm no process is listening for public inbound traffic.
- Confirm no Cloudflare Tunnel/WARP/Zero Trust tunnel is installed or running for this workflow.
- Keep TTL short, currently 10 minutes by default.
- Clinical responses are encrypted by the hospital-side agent when the browser provides an ECDH public key. The Worker stores only the encrypted result envelope for normal shadow workstation queries.

## Current Status

Cloudflare Workers now hosts the full shadow workstation UI and the relay mailbox at one URL:

```text
https://data-viewer.workspace4829.workers.dev
```

Netlify remains optional as a fallback, but is no longer required for the Cloudflare shadow path.
