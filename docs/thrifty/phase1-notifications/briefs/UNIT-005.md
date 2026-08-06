# UNIT-005 — /next UI: notifications toggle, subscribe flow, badge sync, ack

## Objective
Settings toggle to enable/disable push, badge kept honest on focus, session-open
ack. Tests.

## Inputs / context
- `CONTRACT.md` HTTP API + notify policy (binding).
- `frontend-next/src/shell/pwa/store.ts` — extend this store (it owns the SW
  `registration`).
- `frontend-next/src/tabs/settings/store.ts` + `index.tsx` — study the
  existing `action()` helper + how testSearch renders a result row; follow
  that pattern for the toggle.
- `frontend-next/src/tabs/chat/store.ts` — find where a session becomes the
  active/open one (for the ack hook).
- Existing tests: `pwa/store.test.ts`, `settings/store.test.ts` — mirror their
  mocking approach (navigator/serviceWorker stubs, fetch mocks).

## Approach
- pwa store additions: `pushState: 'unsupported'|'no-permission'|'off'|'on'`,
  derived honestly: supported = `registration?.pushManager` exists AND
  `/api/push/status` reports `supported`; on = `getSubscription()` truthy.
  `enablePush()`: `Notification.requestPermission()` (must run in a user
  gesture) → `pushManager.subscribe({userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(publicKey)})` → POST
  `/api/push/subscribe`. `disablePush()`: `getSubscription()?.unsubscribe()`
  → POST `/api/push/unsubscribe {endpoint}`. Errors surface in the store, not
  swallowed.
- Settings tab: a Notifications row with the toggle + status text (including
  the degraded `supported:false` case rendered honestly, and iOS hint text
  when permission is denied).
- Badge sync: on app focus/visibilitychange-to-visible, GET `/api/push/status`
  → `navigator.setAppBadge(unseen)`/clear (feature-detected). On opening a
  chat session: POST `/api/push/ack {session_id}` → set badge from response
  `unseen`. Fire-and-forget with error tolerance (badge sync must never break
  chat).
- Vitest: toggle state transitions with mocked pushManager/fetch; ack fires on
  session open; badge calls feature-detect.

## Constraints
- Honesty rule: no optimistic "on" — state flips only after subscribe+POST
  succeed. No new npm deps. Match file/naming conventions in the touched dirs.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` passes
- [ ] (assertional) toggle round-trip (on→off→on) leaves exactly 0→1 server
  subscriptions per state; permission-denied path shows an honest message and
  stays off; ack posts once per session open

## Dependencies
UNIT-002, UNIT-004
