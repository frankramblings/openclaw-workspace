# Implementation log — wiring no-ops to real endpoints (P0→P9)

Tracks the build-out from `RECOMMENDATIONS.md`. Each entry: what was wired + the endpoint + files. All edits in `frontend-overrides/`, deployed via `scripts/sync-frontend.sh`.

## P0 — orphaned data-act + data-loss bug — ✅ DONE
- **resDiscuss(rid)** — `live/research.js`. Past-research "Discuss" chip → `POST /api/research/spinoff/{rid}` → navigates to chat + `runtime.actions.selectSession(newId)` (loads the spun-off session's thread). Falls back to `go('chat')` if no id.
- **resReport(rid)** — `live/research.js`. "↗ Visual Report" chip → opens `/api/research/report/{rid}` in a new tab.
- **sendCapture()** — `mobile/mobile-app.js` + re-pointed the "Send to Gary" button in `mobile-sheets.js` from `closeCapture`→`sendCapture`. Persists `captureDraft` as a note `POST /api/notes {title, body, kind=remind|note|task}`; optimistic close, restores the text on failure so a capture is never lost. (Was: silently discarded.)
- Verified: `node --check` on all 3 files passes; `runtime.actions` already exposed (app.js:263); `mobileActions` merged (app.js:185); research actions merge via `loadSurface('research')`. Synced to `frontend/`.
