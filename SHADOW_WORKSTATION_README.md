# Shadow Workstation MVP

This adds an external shadow workstation without VPN, reverse tunnel, or inbound firewall access.

## Flow

```text
phone browser -> Netlify shadow page
phone browser -> /api/shadow/request
hospital host -> polls /api/shadow/pending outbound
hospital host -> Onepage/NIS parsers
hospital host -> POST /api/shadow/result
phone browser -> polls /api/shadow/result/:id
```

The hospital host never opens an inbound port to the internet.

## Files

- `shadow/`: static external UI.
- `netlify/functions/`: request/result API backed by Netlify Blobs.
- `app/relay/shadow_poll_agent.mjs`: hospital-side polling relay.
- `Start_Shadow_Relay_Agent.cmd`: starts the hospital-side relay and logs to `app/.local/shadow_relay.log`.

## Required Netlify environment variables

Set these in the Netlify site, scoped to Functions/runtime:

```text
SHADOW_PIN=<short user PIN>
SHADOW_RELAY_KEY=<long random relay key>
SHADOW_TTL_MS=900000
```

Do not commit these values.

## Required hospital host env

In `app/.env`:

```text
SHADOW_API_BASE=https://<your-netlify-site>.netlify.app
SHADOW_RELAY_KEY=<same relay key as Netlify>
SHADOW_PIN=<same PIN as Netlify, only for local reference if needed>
SHADOW_POLL_INTERVAL_MS=3000
```

## Start

1. Keep the normal LAN workstation running:

```powershell
.\Start_Workbench_LAN.cmd
```

2. Start the shadow relay:

```powershell
.\Start_Shadow_Relay_Agent.cmd
```

3. Open the Netlify site on a phone, enter the PIN, then query:
   - physician ward list, e.g. `09432`
   - patient summary, e.g. chart number or bed number

## Current MVP scope

- Physician inpatient roster.
- Patient rounding summary.
- Roster patient click-through.

Next increments can add Labs, TPR, imaging, surgery, and pathology as separate shadow tabs.
