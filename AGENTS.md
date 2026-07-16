# Clinical Tool Agent Notes

## Firewall Safety Rule

Do not perform, propose as an automatic implementation step, or enable any firewall-bypass, firewall-opening, firewall-rule-changing, port-forwarding, tunnel, or equivalent network-exposure action. These actions can trigger security alerts.

Before any action that could alter firewall behavior or bypass network protections, explain the exact change and obtain the user's explicit approval. This rule applies even when the action appears necessary for a relay, remote access, or service-recovery task.

At the end of every operational task, explicitly report whether any firewall-related feature, rule, port listener, tunnel, port forwarding, or network-exposure change was designed or performed.

For every new feature or behavior change, assess and report whether it has any firewall or network-security impact, and whether its traffic pattern, process behavior, or system integration could plausibly trigger abnormal-activity alerts in the hospital information environment. Do not implement a change that creates a material new network-exposure or abnormal-traffic risk without first obtaining the user's explicit approval.

## Shadow Workstation Sync Rule

When changing the LAN workstation UI or data model, update the Netlify shadow workstation in the same change unless the user explicitly scopes the work away from shadow.

Keep these surfaces behaviorally aligned:

- Summary
- TPR
- Labs
- I/O
- Imaging
- Surgery
- Pathology
- Orders
- Nursing
- Blood glucose
- AI assessment
- Open-patient tabs and physician roster workflows

Primary files:

- LAN UI: `app/public/app.js`, `app/public/index.html`, `app/public/styles.css`
- Shadow UI: `shadow/app.js`, `shadow/index.html`, `shadow/styles.css`
- Shared relay shape: `app/services/relay_summary.mjs`
- Shadow API: `netlify/functions/`
- Hospital-side shadow relay: `app/relay/shadow_poll_agent.mjs`

Before finishing shadow-related work, run:

```powershell
node --check shadow/app.js
node scripts/build-shadow.mjs
```

If deploying to Netlify through the current token-file workflow, regenerate the ignored local fallback secret file first:

```powershell
node scripts/write-shadow-local-secrets.mjs
```
