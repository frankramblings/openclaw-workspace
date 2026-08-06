# UNIT-003 — event wiring: followup completion + turn completion → push.send

## Objective
Fire pushes per the contract's notify policy from the two real completion
sites, with tests.

## Inputs / context
- `CONTRACT.md` payload schema + notify policy (binding).
- `backend/followup.py` — the promise lifecycle: `record_completion`,
  `mark(pid, state, ...)`, states pending → completed | overdue | failed.
  Read its module docstring first; it explains the delivery pipeline.
- Turn completion: find where an assistant chat turn finishes server-side —
  start at `backend/bridge.py` (`drive_turn` is referenced from app.py:546)
  and `backend/chat_turn.py`. The right hook fires ONCE per completed turn,
  after the turn's history is finalized, and NOT for aborted/stopped turns.
- `backend/push.py` (UNIT-001).

## Approach
- Followup: at the point a promise transitions to `completed` (and also
  `failed`/`overdue` — Frank should hear about broken promises), call
  `push.mark_unseen(pid, session_id)` then schedule
  `push.send({... kind:"followup", badge: new_count, tag: f"session-{sid}"})`.
  followup.py functions are sync — schedule the async send with the same
  fire-and-forget mechanism the codebase already uses (app.py `_spawn`, or
  `asyncio.get_running_loop().create_task` guarded for no-loop contexts;
  match what followup.py/app.py already do for async side-effects).
- Title/body: short — title = promise label (truncated ~60 chars), body =
  outcome (e.g. "done in 4m12s" / "failed, exit 1"); reuse followup.py's
  `_fmt_duration`.
- Turn: at the completed-turn site, `push.send({kind:"turn", session_id,
  tag: f"session-{sid}", badge: push.unseen_count(), title: <session title
  or "Gary">, body: first ~100 chars of the assistant reply})`. Send always —
  visibility suppression is the SW's job. Never on abort.
- Double-ping guard: a followup delivery itself triggers a turn; same `tag`
  makes the OS coalesce them — verify both sends use the identical
  session-keyed tag.
- Tests: monkeypatch `push.send` (capture payloads); drive
  `record_completion`/`mark` and the turn-completion path via each module's
  existing test seams (look at existing followup/bridge tests for how turns
  are simulated). Assert payload schema fields, badge arithmetic,
  no-send-on-abort.

## Constraints
- Zero behavior change to the existing delivery pipeline (tail/notifier/
  history) — push is purely additive, wrapped so a push failure can never
  break a turn or a promise transition (try/except log-and-continue).

## Acceptance criteria
- [ ] (runnable) `.venv/bin/python -m pytest backend/tests/test_push.py backend/tests/test_followup*.py -q` passes (create/extend as appropriate)
- [ ] (runnable) `.venv/bin/python -m ruff check backend` clean
- [ ] (runnable) full `backend/tests` still green: `.venv/bin/python -m pytest backend/tests -q`
- [ ] (assertional) payloads match contract schema; aborted turns produce no send; push failures cannot propagate into turn/promise code paths

## Dependencies
UNIT-001
