# UNIT-002 — push HTTP endpoints + startup keys

## Objective
The four `/api/push/*` endpoints in `backend/app.py` plus `ensure_keys()` at
startup, with tests.

## Inputs / context
- `CONTRACT.md` HTTP API (binding shapes).
- `backend/app.py` — study 2-3 existing small POST endpoints (e.g.
  `/api/default-chat` around line 838) for Body handling, error style, and the
  startup section (where `chat_search.reindex` is spawned near line 137) for
  the right place to call `push.ensure_keys()`.
- `backend/push.py` from UNIT-001.

## Approach
- Import `push` in app.py's existing grouped import.
- Endpoints are thin: validate minimally (subscribe body must have `endpoint`
  + `keys`), delegate to push.py, return contract shapes. Unknown/absent
  fields → 400 with the error-JSON style app.py already uses.
- `ensure_keys()` on startup only when `push.supported()` — degraded installs
  must not fail boot.
- Tests: extend `backend/tests/test_push.py` using the project's existing
  FastAPI test-client fixture (find how other endpoint tests get a client and
  bypass/satisfy the auth middleware — copy that mechanism exactly). Cover:
  status shape (supported true/false), subscribe→status count, unsubscribe,
  ack session vs ack all, bad bodies → 400.

## Constraints
- Do not restructure app.py; add one clearly-commented block near the other
  small feature endpoints. No auth-middleware changes — endpoints inherit it.

## Acceptance criteria
- [ ] (runnable) `.venv/bin/python -m pytest backend/tests/test_push.py -q` passes
- [ ] (runnable) `.venv/bin/python -m ruff check backend` clean
- [ ] (assertional) response shapes byte-match the contract's HTTP API section

## Dependencies
UNIT-001
