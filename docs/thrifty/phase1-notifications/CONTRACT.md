# Phase 1 — Notifications (web push + badge + overlay shim) — Contract

**Decomposition mode:** partition
**Planning tier:** direct

## Objective

Gary's async work reaches Frank's phone: web push on followup completion and on
chat turns that finish while the app is hidden; app-icon badge counts
completed-but-unseen followups. Full UX in `/next`; the installed overlay PWA
gets a thin shim (SW handlers + one settings button) so pings work before
cutover. Six units: backend push module → HTTP API → event wiring → `/next` SW
→ `/next` UI → overlay shim.

## Conventions

- Python: match `backend/` style (module-level docstring explaining design,
  terse comments on WHY). `ruff check backend` must stay clean (E4/E7/E9/F).
- `pywebpush` is an **optional, lazily-imported** dep per the existing
  `backend/requirements.txt` "Optional features" section: absent → push
  degrades (endpoints report `supported: false`), app boot unaffected.
  The venv is `.venv/` (pywebpush is pre-installed there by the architect).
- Persistence: JSON files under `.data/push/` (`vapid.json`,
  `subscriptions.json`, `unseen.json`), written atomically like
  `followup.py`'s `_save` pattern.
- `/next`: honesty rule — UI state from backend responses only; use the
  settings store's existing `action()` helper pattern; **no new npm deps**.
- Overlay: source edits go to `frontend-vendor/sw.js` +
  `frontend-overrides/js/redesign/` files, and `bash scripts/sync-frontend.sh`
  MUST be run afterwards or nothing deploys. Never touch anything of the
  marissa tenant (:8801) or `frontend/` directly (generated).
- Tests: backend `backend/tests/test_push.py` (+ additions to existing files
  only where a hook's own test file is the natural home); frontend vitest
  colocated per `/next` convention.

## Interfaces (cross-unit)

**`backend/push.py` module API** (owner UNIT-001; consumed by 002/003):
- `supported() -> bool` — pywebpush importable.
- `ensure_keys() -> None` — create VAPID keypair in `.data/push/vapid.json` if
  missing. `public_key() -> str | None` — b64url public key.
- `add_subscription(sub: dict) -> None` (keyed/deduped by `endpoint`),
  `remove_subscription(endpoint: str) -> None`, `subscription_count() -> int`.
- `async send(payload: dict) -> dict` — POST to every subscription via
  pywebpush in a thread executor; prune subs on 404/410; returns
  `{"sent": n, "pruned": n}`; `{"sent": 0, "reason": ...}` when degraded.
- Unseen tracking: `mark_unseen(pid: str, session_id: str) -> int` (returns new
  count), `ack_session(session_id: str) -> int`, `ack_all() -> int`,
  `unseen_count() -> int`.

**HTTP API** (owner UNIT-002; consumed by 005/006). All under the existing
auth middleware; JSON bodies:
- `GET  /api/push/status` → `{"supported": bool, "publicKey": str|null,
  "subscriptions": int, "unseen": int}`
- `POST /api/push/subscribe` — body = browser `PushSubscription.toJSON()` →
  `{"ok": true}`
- `POST /api/push/unsubscribe` — `{"endpoint": str}` → `{"ok": true}`
- `POST /api/push/ack` — `{"session_id": str}` or `{"all": true}` →
  `{"unseen": int}`

**Push payload schema** (owner UNIT-003; consumed by 004/006 SWs):
```json
{"title": str, "body": str, "kind": "followup"|"turn",
 "session_id": str|null, "tag": "session-<id>"|str, "badge": int}
```
- `badge` = unseen-followup count at send time (turn-kind sends current count
  too — it never increments it).
- `tag` is session-keyed so a followup ping and its turn ping coalesce (OS
  replaces same-tag notifications).
- Each SW builds its own deeplink URL from `session_id` using its app's real
  routing (discovered in-unit); fallback = app root.

**Notify policy** (pinned; Frank's decision 2026-07-20):
- Followup completion → always notify + `mark_unseen`.
- Chat turn completion → always **send**; the receiving SW checks its own
  `clients` and shows no banner if a focused/visible client exists (still sets
  badge). Aborted/stopped turns never send.
- Badge counts followups ONLY. `setAppBadge(badge)`; 0 → `clearAppBadge()`.
- Clients POST `/api/push/ack {session_id}` when Frank opens a session, then
  set badge from the response.

## Glossary

- **followup / promise** — `backend/followup.py` records; "completion" =
  the promise transition handled in `mark()` / `record_completion` flow.
- **unseen** — a completed followup whose session Frank hasn't opened since.
- **overlay** — vendor+overrides app served at `/`; **`/next`** — React app.

## Ownership map

- UNIT-001 → `backend/push.py` (new), `backend/requirements.txt` (one line),
  `backend/tests/test_push.py` (new)
- UNIT-002 → `backend/app.py` (push endpoints + startup `ensure_keys`),
  `backend/tests/test_push.py` (extend)
- UNIT-003 → `backend/followup.py` + turn-completion site in
  `backend/bridge.py`/`backend/chat_turn.py` (discovered in-unit), tests
- UNIT-004 → `frontend-next/public/sw.js` (push/notificationclick/badge)
- UNIT-005 → `frontend-next/src/shell/pwa/store.ts` (+push subscribe state),
  `frontend-next/src/tabs/settings/` (toggle), chat session-open ack, tests
- UNIT-006 → `frontend-vendor/sw.js`, `frontend-overrides/js/redesign/live/settings.js`
  (+ `surfaces.js` panel row), sync-frontend run

## Dependency graph

```text
UNIT-001
   ↓
UNIT-002, UNIT-003     (both need push.py; independent of each other)
   ↓
UNIT-004               (payload schema; after 002 for /api/push/status shape)
   ↓
UNIT-005, UNIT-006     (need API + SW patterns)
```
Build order for the single executor: 001 → 002 → 003 → 004 → 005 → 006.

## Gates

- Backend units: `.venv/bin/python -m pytest backend/tests/test_push.py -q`
  (plus any test file the unit touched) and `.venv/bin/python -m ruff check backend`.
- `/next` units: `cd frontend-next && npm run build && npm test` (build =
  `tsc --noEmit && vite build` — the ship command).
- UNIT-006: `bash scripts/sync-frontend.sh` completes with sw.js precache +
  CACHE_NAME stamp lines printed.
- Integration (architect): full `backend/tests` suite, deploy, on-device iOS
  check is Frank's punch list (cannot be automated).
