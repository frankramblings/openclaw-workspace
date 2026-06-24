# Handoff: Durable / Resumable Chat Streaming (Workspace PWA)

**Status:** Part 1 (backend) IMPLEMENTED + unit-tested on branch `chat-resume-detached` (commit `e4ba7c1`, pushed to origin; `backend/tests/test_chat_resume_detached.py` — 2 passed). The detached recorder (`_record_turn`/`_start_turn_recorder`) now owns the turn so it survives the reader leaving. STILL TODO: end-to-end manual verification (§7), Part 2 (frontend resume-on-mount) and Part 3 (per-session working indicator) are NOT done. Pick up from `git checkout chat-resume-detached`.
**Owner asked for:** seamless "leave a thread / refresh / multitask and come back" behavior like Claude Code / Claude Cowork.
**Risk level:** Touches the **core chat path** (the live agent conversation). Build on a branch, verify, then merge. Do **not** hot-patch on `main`.

---

## 1. The problem (user-facing symptoms)

Frank reports, on both desktop and mobile:

1. Leave a chat thread mid-run and come back → **no indication it's still working**, and no progress made while away.
2. **Refresh the browser** mid-run → the live view is gone; the reply only reappears once the turn fully finishes and history is re-fetched.
3. No way to tell, from elsewhere in the app, **which threads are currently working**.

Goal: pop between views / refresh / switch threads and always pick back up — see live progress if still running, see the final result if done. Intuitive and seamless.

---

## 2. Root cause

The chat streams over a **single POST** `/api/chat_stream`, and the live run state lives **only** in:
- that POST request's response body (an SSE generator), and
- an in-memory `turn` object in the frontend module (`live/chat.js`).

Consequences:
- **Thread switch:** `selectSession()` swaps `chat.activeId` and re-fetches plain history (`/api/history/{id}`). It never preserves or restores an in-flight run. The still-running stream keeps mutating a now-detached `chat.thread`/`turn`.
- **Refresh:** the POST connection dies with the page. There is **no re-attach mechanism** wired in the frontend, so the live turn is invisible until it finishes.
- **No per-session "working" state** exists in the sidebar/list UI at all.

---

## 3. What ALREADY EXISTS in the backend (the good news)

The hard part is built — it's just **not fully wired**. Backend is FastAPI: `backend/app.py` (uvicorn, systemd user unit — see §7).

### 3a. Resumable event log — `backend/event_store.py`
A per-`session_key` pub/sub event log. Public API:
- `append(session_key, payload) -> str` (returns event id / seq)
- `since(session_key, last_event_id) -> [(eid, payload), ...]`
- `latest_id(session_key) -> str|None`
- `begin_turn(session_key)` / `end_turn(session_key)` — set turn boundary + active flag
- `current_turn(session_key) -> {active, turn_start_id, events:[{id,data}], last_event_id}`
- `subscribe(session_key) -> asyncio.Queue` / `unsubscribe(session_key, queue)`

### 3b. Resume/tail endpoints — `backend/resume_route.py` (router IS included in app.py ~line 86)
- `GET /api/chat/events/resume?session=<id>&last_event_id=<id?>` — replay backlog + status
- `GET /api/chat/turn?session=<id>` — returns `current_turn()`: lets a reloaded client detect an active turn and rebuild it from its first event
- `GET /api/chat/stream?session=<id>&last_event_id=<id?>` — **EventSource-compatible live tail**: replays `since(cursor)` then streams new events via a `subscribe()` queue

### 3c. Detached recorder (built, but `chat_stream` doesn't use it) — `backend/app.py`
- `_record_turn(session_key, source)` (~line 108): the "single writer" — drains a turn's SSE generator into `event_store` **independent of any reader**, always lands a terminal `[DONE]`, calls `begin_turn`/`end_turn`. This is exactly the "run survives the reader leaving" primitive.
- `_start_turn_recorder(session_key, source_factory)` (~line 135): launches `_record_turn` as a detached `asyncio.Task`, guarded so it won't double-start.
- `_TURN_TASKS: dict[str, asyncio.Task]` and `_ACTIVE_RUNS: dict[str, dict]` (~lines 92–101).

### 3d. Stop already wired
`POST /api/chat/stop/{session_id}` → `chat.abort` on the gateway. Keep compatible.

### 3e. Dead stubs to delete/replace
In `backend/app.py` there are **leftover stub routes** that shadow the concept and return empty:
- `GET /api/chat/resume/{session_id}` → `{messages: []}` (~line 766)
- `GET /api/chat/stream_status/{session_id}` → `{active: False}` (~line 771)
These are NOT the real endpoints (the real ones live in `resume_route.py` under `/api/chat/events/resume`, `/api/chat/turn`, `/api/chat/stream`). Remove or repoint to avoid confusion. **Verify nothing else calls the stubs first.**

---

## 4. The actual gaps to close

### Gap A — backend: `chat_stream` doesn't go through the detached recorder, and never calls `begin_turn`
In `backend/app.py`, `@app.post("/api/chat_stream")` → inner `gen()` (~lines 450–629):
- It **tees** every chunk inline: `eid = event_store.append(session_key, chunk); yield f"id: {eid}\n{chunk}"`. Good — so `since`/`subscribe` tails work *while a reader is connected*.
- BUT the teeing happens **inside the POST's own generator**. If the POST reader disconnects (refresh / tab close / fetch abort on thread-switch), uvicorn cancels `gen()`, which stops the teeing **and** stops pulling `bridge.stream_turn` — so recording halts and events between disconnect and reconnect are lost. The detached `_record_turn`/`_start_turn_recorder` (§3c) was built to fix exactly this but **is not called** from `chat_stream`.
- ALSO: `gen()`'s `finally` calls `event_store.end_turn(...)` but **`begin_turn` is never called on this path** (the only caller is inside `_record_turn`, which chat_stream bypasses). Net effect: `current_turn()` reports `active=false` and empty `events` even while events are flowing → `/api/chat/turn` can't detect a working session or rebuild the in-flight turn. `event_store.begin_turn`'s own docstring claims "Called from chat_stream just before the relay loop" — that call is missing.

**Fix:** make the turn run through the detached recorder so the gateway run + recording survive the reader leaving, and ensure `begin_turn` fires at turn start. Then the POST reader (and every other reader) becomes just a tail of `event_store`. The cleanest shape: `chat_stream` calls `_start_turn_recorder(session_key, source_factory=<gen>)` then returns a `StreamingResponse` that tails `event_store` (replay `current_turn` then `subscribe`) instead of consuming `gen()` directly. Confirm `bridge.stream_turn` keeps the gateway run alive when the POST disconnects (it should, since the recorder, not the reader, drives it once detached).

### Gap B — frontend: nothing uses the resume endpoints
`frontend-overrides/js/redesign/live/chat.js` only ever calls `postStream('/api/chat_stream', ...)` (in `actions.send`, ~line 591). It never calls `/api/chat/turn`, `/api/chat/stream`, or `/api/chat/events/resume`. `actions.selectSession` (~line 367) and `load` (~line 186) only fetch `/api/history` + `/api/sessions`.

---

## 5. Implementation plan (recommended: all three in one branch)

### Part 1 — Backend detach + begin_turn (small, surgical)
- Route `chat_stream` through `_start_turn_recorder` (or otherwise guarantee the recorder owns the turn), so a dropped reader can't stop or lose the run.
- Ensure `event_store.begin_turn(session_key)` is called at turn start so `current_turn()` reports `active` + the turn's events.
- Make the POST `/api/chat_stream` reader a tail of `event_store` (replay-then-subscribe), identical to `/api/chat/stream`. End result: POST, thread-switch return, and post-reload resume are all just tails.
- Delete/repoint the dead stubs in §3e.
- Keep `/api/chat/stop/{id}` behavior intact.

### Part 2 — Frontend resume-on-mount (the visible win)
In `live/chat.js`:
- Add a `live/api.js` EventSource helper usage (it already has `openSSE(path, onEvent)` / `EventSource` wrapper at `live/api.js:78`).
- On **chat open / thread-switch / page load** (`selectSession`, initial `load`): call `GET /api/chat/turn?session=<id>`. If `active`:
  1. Rebuild the in-progress assistant turn by replaying `events` through the **same `onEvent` reducer** already in `actions.send` (refactor that `onEvent` out so it's reusable for replay + live).
  2. Open `GET /api/chat/stream?session=<id>&last_event_id=<turn.last_event_id>` (EventSource) and feed it the same `onEvent` until `[DONE]`.
- **Decouple the live stream/turn state from `chat.activeId`** so switching away never clobbers an in-flight turn. Key the live turn by session id, not by "the currently visible chat."
- Make `actions.send` also tolerate the resume model (e.g. after POST, the live tail is `/api/chat/stream`; or keep POST as-is if Part 1 makes POST itself resumable). Pick one consistent path.

### Part 3 — Per-session "working" indicator
- Sidebar rows (`frontend-overrides/js/redesign/surfaces.js`, conv rows) + mobile list (`frontend-overrides/js/redesign/mobile/`): show a small spinner/dot when a session has an active turn.
- Source of truth: `current_turn().active`. Either (a) cheap poll of `/api/chat/turn` for visible sessions, or (b) add a tiny `/api/chat/active_sessions` returning the set of session_keys with `_TURN_ACTIVE` true (preferred — one call). Map gateway `session_key` ↔ SPA session id via `sessions_store`.

---

## 6. Key file map

| Concern | Path |
|---|---|
| Chat frontend logic (send/stream/select/history) | `frontend-overrides/js/redesign/live/chat.js` |
| API helpers incl. EventSource wrapper | `frontend-overrides/js/redesign/live/api.js` (`openSSE`, ~line 78) |
| Sidebar chat list / rows | `frontend-overrides/js/redesign/surfaces.js` |
| Mobile surfaces/list | `frontend-overrides/js/redesign/mobile/` |
| Activity tree rendering (steps/tools) | `frontend-overrides/js/redesign/chat-activity.js` |
| Backend app + chat_stream + dead stubs | `backend/app.py` |
| Resumable endpoints | `backend/resume_route.py` |
| Event log | `backend/event_store.py` |
| Session id ↔ gateway key | `backend/sessions_store.py` |
| Gateway relay | `backend/bridge.py` (`stream_turn`) |

---

## 7. Build / deploy / verify

**Repo:** `~/openclaw-workspace` (host `bespin`/`naboo`; git remote `github.com:frankramblings/openclaw-workspace.git`, branch `main`).

**Backend service (systemd user unit):**
```
systemctl --user restart openclaw-workspace.service
journalctl --user -u openclaw-workspace.service -f      # logs
```
Backend serves on `127.0.0.1:8800`. Frontend overrides under `frontend-overrides/` are synced/served by the app (see `frontend-overrides/js/redesign/README.md` and the repo's sync script).

**Manual verification (must pass before merge):**
1. Start a long-running turn (ask the agent to do something multi-step).
2. Switch to another thread, switch back → in-flight turn still rendering, progress retained.
3. Hard-refresh the browser mid-turn → turn re-attaches and continues to completion; final result lands.
4. Same on mobile.
5. Sidebar shows a working indicator on the running thread while you're elsewhere.
6. Let a turn finish while you're on another thread → coming back shows the completed result, not a blank.
7. Stop button still aborts. New chat still works. No double-rendered replies (watch the `reply_reset` handling in `onEvent`).

Use the attached web-chat terminal for commands (Frank watches it live):
```
curl -sS http://127.0.0.1:8800/api/terminal/mcp/run -H 'content-type: application/json' \
  -d '{"token":"<token-from-turn-context>","command":"<cmd>"}'
```

---

## 8. Guardrails / notes

- This is the path Frank uses to talk to the assistant — **branch + verify, don't hot-patch main.**
- Preserve existing `onEvent` semantics: `done`, `error` (404 → reloadSessions), `reply_reset` (prevents doubled "Sent…reply"), thinking deltas, prose deltas, `tool_start`/`tool_output`. Reuse it for replay so rebuilt turns look identical to live ones.
- The "late reply" path (agent replies via its `message` tool after the run lifecycle ends) is handled in `chat_stream` — make sure it still lands in the event log so resumed clients get it.
- Don't break `/api/history` (used for completed-thread load and copy/export transcript).
- Mind the macOS `._*` / `.DS_Store` junk — don't commit it.

---

## 9. Recent related context

- MEMORY note (Frank): "workspace chat needs a more durable stream model (replayable event log, per-thread SSE/WS reconnect with cursor, buffered backfill on mount) AND borrow Control UI's collapsible-source rendering." This work is the durable-stream half.
- Just-shipped UX polish on this branch lineage: composer auto-grow, markdown strip in previews, mobile sheet fixes, overflow-wrap for long tokens.

---

*Written 2026-06-24 from a live investigation session. All line numbers approximate — grep the function names, they're stable.*
