# Clinical Tool Agent Notes

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
