# UNIT-004 — /next service worker: push + notificationclick + badge

## Objective
Extend `frontend-next/public/sw.js` with push handling per the contract.

## Inputs / context
- `CONTRACT.md` payload schema + notify policy (binding).
- `frontend-next/public/sw.js` (38 lines) — match its style exactly (const
  arrow-less handlers, terse comments, no build step: this file ships as-is).
- `/next` routing: check `frontend-next/src/shell/router.ts` for how a chat
  session is addressed in the URL (hash/query). Deeplink =
  `/next/` + that format; if sessions aren't URL-addressable, deeplink to
  `/next/` root.

## Approach
- `push` handler: parse `event.data.json()` (guard malformed → generic
  notification). If `kind === "turn"`: check
  `clients.matchAll({type:'window'})` — if any client `visibilityState ===
  'visible'`, skip `showNotification` (still do badge). Always:
  `registration.showNotification(title, {body, tag, data:{url}})` (when not
  suppressed) and `navigator.setAppBadge(badge)` / `clearAppBadge()` when
  badge is 0 (feature-detect: `'setAppBadge' in navigator`).
- `notificationclick`: close notification; focus an existing `/next` client
  (`client.focus()` + `client.navigate(url)` when supported) else
  `clients.openWindow(url)`.
- All logic inside `event.waitUntil(...)`.

## Constraints
- Zero changes to the existing fetch/cache logic. No imports — SW stays a
  single self-contained file. Don't touch `CACHE` version (asset caching is
  unrelated; browsers byte-diff SW updates).

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` passes
- [ ] (runnable) `node --check frontend-next/public/sw.js` passes
- [ ] (assertional) turn-kind pushes with a visible client show no banner but still update the badge; badge 0 clears; malformed payload cannot throw out of the handler

## Dependencies
UNIT-002 (API shapes final), payload schema from UNIT-003's contract section
