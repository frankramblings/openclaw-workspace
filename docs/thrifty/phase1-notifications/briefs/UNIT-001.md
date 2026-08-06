# UNIT-001 — backend/push.py core module

## Objective
New `backend/push.py`: VAPID key management, subscription store, web-push
sender, unseen-followup tracking. Plus the requirements line and tests.

## Inputs / context
- `CONTRACT.md` module API (binding).
- `backend/followup.py` — copy its `_store_file`/`_load`/`_save` atomic-JSON
  persistence pattern and module-docstring style.
- `backend/config.py` — find how `.data` paths are derived (followup.py shows
  usage); store under `.data/push/`.
- `.venv/bin/python` has `pywebpush` installed already.

## Approach
- Lazy-import pywebpush inside functions (module import must not fail without
  it) — mirror how optional deps are handled per requirements.txt comments.
- VAPID: generate once via `py_vapid` (ships with pywebpush) or the
  `cryptography` ec API; persist private+public in `.data/push/vapid.json`
  (0600). `public_key()` returns the b64url application-server key browsers
  expect.
- `send()`: iterate subscriptions, call `pywebpush.webpush` per sub inside
  `asyncio.get_running_loop().run_in_executor` (it's blocking); catch
  `WebPushException`; on 404/410 remove that subscription; never raise out.
  VAPID claims sub: `mailto:frank@localhost` is fine.
- Unseen store: dict `{pid: session_id}` in `unseen.json`; functions per
  contract.
- requirements.txt: add `pywebpush>=2` under the Optional features section
  with a comment matching the existing style (lazily imported; absent = push
  degrades).
- Tests (`backend/tests/test_push.py`): match existing backend test style
  (look at one small existing test file first). Cover: keygen idempotence,
  add/dedupe/remove subscription, unseen mark/ack/ack_all counts, `send()`
  degraded path (monkeypatch import failure) and prune-on-410 (monkeypatch
  webpush to raise a WebPushException with a 410 response). Point the store at
  `tmp_path` via whatever config/monkeypatch mechanism existing tests use for
  `.data`.

## Constraints
- No changes to app.py (that's UNIT-002). No print/logging spam — use the
  `logging` pattern seen in app.py if logging at all.
- Atomic writes; corrupt/missing JSON files must self-heal to empty state.

## Acceptance criteria
- [ ] (runnable) `.venv/bin/python -m pytest backend/tests/test_push.py -q` passes
- [ ] (runnable) `.venv/bin/python -m ruff check backend` clean
- [ ] (runnable) `.venv/bin/python -c "import backend.push"` succeeds even with pywebpush absent (test simulates)
- [ ] (assertional) module API matches CONTRACT exactly (names/signatures/returns)

## Dependencies
none
