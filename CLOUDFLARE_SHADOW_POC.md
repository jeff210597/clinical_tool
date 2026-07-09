# Cloudflare Shadow Workstation POC

This POC uses Cloudflare only as a public test page and request/result mailbox.

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

- `cloudflare/worker.mjs` - Worker API mailbox.
- `cloudflare/schema.sql` - D1 schema.
- `cloudflare/pages/index.html` - minimal standalone test page, kept as a reference.
- `cloudflare/wrangler.toml.example` - deployment template.
- `app/relay/cloudflare_poll_agent.mjs` - hospital-side outbound polling agent.
- `Start_Cloudflare_Relay_Agent.cmd` - echo-only starter.

## API

- `GET /health`
- `POST /api/cf-shadow/request`
- `GET /api/cf-shadow/result/:id`
- `GET /api/cf-shadow/agent/poll`
- `POST /api/cf-shadow/agent/respond`

## Required Cloudflare Setup

Install and login to Wrangler, or provide a Cloudflare API token with permissions for Workers, Pages, and D1.

Create a D1 database:

```powershell
npx wrangler d1 create clinical-tool-shadow-poc
```

Copy `cloudflare/wrangler.toml.example` to `cloudflare/wrangler.toml` and fill `database_id`.

Apply schema:

```powershell
npx wrangler d1 execute clinical-tool-shadow-poc --remote --file cloudflare/schema.sql
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

Open the Worker URL directly to use the built-in test page. Cloudflare Pages is not required for the POC.

## Local Agent Configuration

Add to `app/.env`:

```text
CF_SHADOW_API_BASE=https://<your-worker>.<account>.workers.dev
CF_SHADOW_RELAY_KEY=<same as Worker secret>
CF_SHADOW_POLL_INTERVAL_MS=3000
CF_SHADOW_ECHO_ONLY=1
```

Run first in echo-only mode:

```powershell
Start_Cloudflare_Relay_Agent.cmd
```

Or:

```powershell
$node="$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node app\relay\cloudflare_poll_agent.mjs --check-config
& $node app\relay\cloudflare_poll_agent.mjs --echo-only
```

Only after connectivity is proven should `CF_SHADOW_ECHO_ONLY` be removed.

## Safety Checklist Before Clinical Use

- Verify `GET /health` works from the hospital workstation.
- Verify `--echo-only` request/response works from the Worker root page in the phone browser.
- Confirm no process is listening for public inbound traffic.
- Confirm no Cloudflare Tunnel/WARP/Zero Trust tunnel is installed or running for this workflow.
- Keep TTL short, currently 10 minutes by default.
- Do not deploy real clinical data to Cloudflare until application-layer encryption is added and tested.

## Current Status

This is a connectivity POC. It is intended to answer:

1. Can the hospital workstation make outbound HTTPS requests to Cloudflare Worker?
2. Can a phone browser submit a request and read the response?
3. Is the latency acceptable compared with Discord relay?

It is not yet a production clinical-data transport.
