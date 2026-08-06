# UNIT-006 — overlay shim: SW handlers + Enable-notifications button

## Objective
The installed overlay PWA (scope `/`) receives pushes and can subscribe:
push/notificationclick in `frontend-vendor/sw.js`, an Enable/Disable
notifications control in overlay Settings, badge + ack wiring. Then deploy via
sync-frontend.

## Inputs / context
- `CONTRACT.md` payload schema + HTTP API (binding).
- `frontend-vendor/sw.js` (115 lines) — append handlers; do NOT touch
  CACHE_NAME or the `/*__PRECACHE__*/` token (sync-frontend.sh rewrites both).
- `frontend-overrides/js/redesign/live/settings.js` — `persistSetting`,
  `apiErrorMessage`, `load(state)` patterns; `frontend-overrides/js/redesign/surfaces.js`
  `settingsSurface` for where panel rows are declared.
- Overlay routing: check `frontend-overrides/js/redesign/app.js` for how a
  chat session is addressed (hash/query) → notificationclick deeplink format;
  fallback `/`.
- Badge/ack: overlay chat session-open lives in
  `frontend-overrides/js/redesign/live/chat.js` — add the ack POST at the
  session-open point; badge sync on visibilitychange in a small shared spot
  (app.js init or settings.js — pick the least invasive).
- GIT CAUTION: `frontend-overrides/` and `frontend-vendor/` contain UNRELATED
  uncommitted WIP from another session. Edit only what this unit owns; never
  revert or reformat surrounding hunks.

## Approach
- SW: same handler logic as UNIT-004's (turn-kind visibility suppression,
  badge set/clear, tag, notificationclick focus-or-open) transliterated to
  this file's promise style. Keep it byte-lean.
- Settings: an "Enable notifications on this device" row in the overlay
  Settings surface → on tap: permission request + subscribe + POST (same flow
  as UNIT-005, vanilla JS); shows current state from `/api/push/status` +
  `getSubscription()`; disable path unsubscribes. iOS remark in the row's
  hint text (works when installed to Home Screen).
- Deploy: run `bash scripts/sync-frontend.sh`; confirm its sw.js precache +
  CACHE_NAME stamp output lines appear.

## Constraints
- This is the ONLY overlay work in the phase — no other overlay changes,
  no refactors. Never touch `frontend/` (generated) directly.

## Acceptance criteria
- [ ] (runnable) `node --check frontend-vendor/sw.js` and `node --check frontend-overrides/js/redesign/live/settings.js` pass
- [ ] (runnable) `bash scripts/sync-frontend.sh` completes, printing the precache-injection and CACHE_NAME-stamp lines
- [ ] (runnable) generated `frontend/sw.js` contains the push handler (grep `addEventListener('push'`)
- [ ] (assertional) no diff hunks outside the files/regions this unit owns; existing fetch/cache SW logic untouched

## Dependencies
UNIT-002 (API), UNIT-004 (handler logic to mirror)
