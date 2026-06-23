# Findings — parity gaps & wiring issues

Append-only. One bullet per issue: `file:line` + the fix made, or `deferred — needs human: <what decision is missing>`.
Note in a bullet if a fix also requires Frank to re-run `scripts/sync-frontend.sh` (audit target is `frontend/`, deployed copy is `frontend-overrides/`).

- **Settings card launchers are dead** — `frontend/js/redesign/surfaces.js:479` renders `<button class="set-launcher">${c.launcher}</button>` with **no `data-act`** and there is no class-based click handler anywhere in `frontend/js/redesign/`. This makes three buttons no-ops: **"Open Brain"** (settings-data.js:106), **"Open Scheduled jobs"** (settings-data.js:107), **"Open theme picker"** (settings-data.js:109). Discovered while auditing parity for the old `close-memory-modal` (index.html:377): the old Brain *modal* is intentionally replaced by the Settings → Brain card, but the card cannot actually be opened.
  - `deferred — needs human:` what should each launcher open? The redesign has **no Brain/memory surface, no Scheduled surface, and no theme-picker surface/modal** to route to — only the descriptive settings cards exist. Wiring these requires deciding the target (a new nav surface? a companion panel? a modal port of the old `memory-modal`/`cron`/theme UIs?) and building it — a design decision + likely a backend call, beyond a one-line wiring fix.
  - When fixed in `frontend-overrides/`, Frank must re-run `scripts/sync-frontend.sh` to deploy.
