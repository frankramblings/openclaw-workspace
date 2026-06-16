# Attached Terminal — PR2 (Gary-drive) Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. TDD per task; checkbox steps.

**Goal:** Let Gary drive each chat's attached terminal (the same PTY the human sees), bound *precisely* to the chat whose turn Gary is answering, gated by a per-chat "Gary can do anything here" toggle (default on).

**Architecture (token path — chosen after the spike):** OpenClaw exposes no session id to the agent's tool env on the codex/dist stack, so the workspace mints a **per-turn opaque token** mapping to the chat's `session_key`, injects it into the turn's message (websearch/draft-mode pattern), and Gary passes it to a `terminal` MCP tool. The MCP server (mcporter, in the live tree) calls loopback FastAPI endpoints that resolve token→session, enforce the toggle, and drive the existing PR1 `PtySession`. Output streams to the human panel too (same PTY).

**Tech stack:** Python/FastAPI; Node MCP server (`@modelcontextprotocol/sdk`, already present in the live tree); plain-JS panel toggle.

**Spec:** `docs/superpowers/specs/2026-06-16-attached-terminal-design.md` (§4 toggle, §5 MCP + precise binding, §6 bridge hint).

**Key facts (from scout):**
- Global settings store: `backend/websearch.py` `load_settings()`/`save_settings(patch)` → `.data/settings.json`. Routes `GET/POST /api/auth/settings` (app.py:682-691).
- Per-session store: `backend/sessions_store.py` — `create()` (record shape ~:70-88), `update(id, **fields)` with allow-list (~:99), `get(id)`, `session_key_for(id)`.
- Turn injection: `backend/app.py` `chat_stream.gen()` mutates `brain_message` (~app.py:415-422) before `bridge.stream_turn`; history strip at ~app.py:531-533. `rec = sessions_store.get(...)` already loaded (~app.py:373).
- PR1 PTY: `backend/terminals.py` — `_sessions`, `get_or_create(session_key)`, `PtySession.write/drain_once/buffer/attach_reader`, `terminal_access_allowed` (loopback allowed).
- Live tree (NOT this repo): `/Users/admin/.openclaw/workspace/` holds `config/mcporter.json`, `bin/*-mcp.mjs`, `AGENTS.md`, `TOOLS.md`. `bin/gdocs-mcp.mjs` is the pattern (McpServer + registerTool + zod + StdioServerTransport; SDK `@modelcontextprotocol/sdk ^1.29.0` + `zod` present).

---

## Task ordering

1. **Backend foundation** (this repo, TDD) — Gary-mode state, per-turn token, always-on PTY reader, MCP endpoints. Self-contained + unit-tested.
2. **Turn injection** (this repo) — app.py prepends capability hint + token when mode on; history strip.
3. **Frontend toggle** (this repo) — panel header toggle (per-chat) + global default.
4. **MCP server + registration + docs** (LIVE tree) — `bin/terminal-mcp.mjs`, `config/mcporter.json`, `TOOLS.md`/`AGENTS.md`.
5. **Deploy + live validation** — ff-merge, sync-frontend, restart, mcporter reload; user has Gary run a command and confirms it appears in their panel.

Tasks 1–3 land on branch `frank/terminal-gary-drive`. Task 4 edits the live tree directly (not version-controlled here). Task 5 is user-gated (restart).

---

### Task 1: Backend foundation — Gary-mode, token, MCP endpoints

**Files:** Modify `backend/terminals.py`, `backend/sessions_store.py`; Test `backend/tests/test_terminals_mcp.py`.

**Design (signatures to implement in `terminals.py`):**

- **Always-on reader (fixes a PR1 latent gap):** make `get_or_create(session_key)` attach the asyncio reader to the running loop so the scrollback `buffer` stays current even with no WS connected (today output is only drained while a WS is attached). `attach_reader` is already idempotent. Add, inside `get_or_create` after spawn, a best-effort: `try: sess.attach_reader(asyncio.get_running_loop()) except RuntimeError: pass` (no running loop in sync unit tests → skipped; endpoints/WS run in the loop).

- **Per-turn token map** (module-level, TTL):
  ```python
  import secrets, time
  _TERMINAL_TOKENS: dict[str, tuple[str, float]] = {}  # token -> (session_key, expires_at)
  TERMINAL_TOKEN_TTL = 1800.0  # 30 min; covers a long turn

  def mint_terminal_token(session_key: str) -> str:
      _prune_terminal_tokens()
      token = secrets.token_urlsafe(18)
      _TERMINAL_TOKENS[token] = (session_key, time.time() + TERMINAL_TOKEN_TTL)
      return token

  def resolve_terminal_token(token: str) -> str | None:
      _prune_terminal_tokens()
      entry = _TERMINAL_TOKENS.get(token)
      return entry[0] if entry else None

  def _prune_terminal_tokens() -> None:
      now = time.time()
      for t in [t for t, (_, exp) in _TERMINAL_TOKENS.items() if exp <= now]:
          _TERMINAL_TOKENS.pop(t, None)
  ```

- **Gary-mode resolution** (effective = per-session override else global default; global default ON):
  ```python
  def gary_mode_default() -> bool:
      from . import websearch
      return bool(websearch.load_settings().get("gary_terminal_default", True))

  def gary_mode_for_session(session_key: str) -> bool:
      from . import sessions_store
      override = sessions_store.gary_terminal_override(session_key)  # None | bool
      return override if isinstance(override, bool) else gary_mode_default()
  ```

- **MCP endpoints** (loopback already allowed by `terminal_access_allowed`; the TOKEN is the real auth — an invalid/expired token 404s, a mode-off session 403s):
  ```python
  @router.post("/api/terminal/mcp/run")
  async def terminal_mcp_run(request: Request):
      body = await request.json()
      session_key = resolve_terminal_token(str(body.get("token", "")))
      if not session_key:
          raise HTTPException(404, "invalid or expired terminal token")
      if not gary_mode_for_session(session_key):
          raise HTTPException(403, "Gary terminal control is off for this chat")
      sess = get_or_create(session_key)
      sess.attach_reader(asyncio.get_running_loop())
      command = str(body.get("command", ""))
      cursor = len(sess.buffer)
      sess.write(command + "\n")
      output = await _await_settled_output(sess, cursor, settle=1.2, cap=float(body.get("timeout", 20)))
      return {"output": output, "exited": sess.exited, "exit_code": sess.exit_code}

  @router.post("/api/terminal/mcp/read")
  async def terminal_mcp_read(request: Request):
      body = await request.json()
      session_key = resolve_terminal_token(str(body.get("token", "")))
      if not session_key:
          raise HTTPException(404, "invalid or expired terminal token")
      sess = _sessions.get(session_key)
      tail = int(body.get("tail", 4000))
      return {"output": (sess.buffer[-tail:] if sess else ""), "running": bool(sess and not sess.exited)}

  @router.post("/api/terminal/mcp/write")
  async def terminal_mcp_write(request: Request):
      body = await request.json()
      session_key = resolve_terminal_token(str(body.get("token", "")))
      if not session_key:
          raise HTTPException(404, "invalid or expired terminal token")
      if not gary_mode_for_session(session_key):
          raise HTTPException(403, "Gary terminal control is off for this chat")
      sess = get_or_create(session_key)
      sess.attach_reader(asyncio.get_running_loop())
      sess.write(str(body.get("data", "")))
      return {"ok": True}
  ```
  with the settle helper:
  ```python
  async def _await_settled_output(sess, cursor: int, settle: float, cap: float) -> str:
      """Poll until output stops growing for `settle` seconds, or `cap` elapses."""
      loop = asyncio.get_running_loop()
      deadline = loop.time() + cap
      last_len = len(sess.buffer)
      quiet_until = loop.time() + settle
      while loop.time() < deadline:
          await asyncio.sleep(0.1)
          if len(sess.buffer) != last_len:
              last_len = len(sess.buffer)
              quiet_until = loop.time() + settle
          elif loop.time() >= quiet_until:
              break
      return sess.buffer[cursor:]
  ```

- **`sessions_store.py` additions:** add `"gary_terminal": None` to the `create()` record; add `"gary_terminal"` to the `update()` allow-list; add helpers:
  ```python
  def gary_terminal_override(session_key: str):
      rec = _by_session_key(session_key)   # find record whose "sessionKey" == session_key
      return rec.get("gary_terminal") if rec else None
  def set_gary_terminal(session_id: str, enabled):  # enabled: bool | None (None = inherit)
      update(session_id, gary_terminal=enabled)
  ```
  (Add a `_by_session_key` lookup if none exists. `update`'s allow-list must permit `None` for `gary_terminal` to mean inherit.)

**TDD steps:**
- [ ] **Write `backend/tests/test_terminals_mcp.py`** covering: token mint→resolve roundtrip; expired token resolves to None (monkeypatch `time.time` or set TTL=0); `resolve_terminal_token("bad")` is None; `gary_mode_for_session` returns global default when no override and the override when set (monkeypatch `websearch.load_settings` + `sessions_store.gary_terminal_override`); and a FastAPI `TestClient` check that `POST /api/terminal/mcp/run` with a bad token → 404 and with a minted token whose session has mode off → 403. (Use the app's TestClient like `backend/tests/test_app_config.py`; for the run-happy-path, a real PTY echo with a short command, asserting the command's output appears — reuse a deadline poll.)
- [ ] **Run** `/Users/admin/openclaw-workspace/.venv/bin/python -m pytest backend/tests/test_terminals_mcp.py -q` → fail (endpoints/helpers missing).
- [ ] **Implement** the helpers + endpoints + sessions_store changes above.
- [ ] **Run** tests → pass. Also re-run `backend/tests/test_terminals.py` (PR1) → still green.
- [ ] **Commit** `feat(terminal): Gary-mode state, per-turn token, MCP-facing endpoints`.

### Task 2: Turn injection (capability hint + token)

**Files:** Modify `backend/app.py` (and a small helper in `backend/terminals.py`).

- [ ] Add `terminals.gary_capability_note(session_key) -> str` that mints a token and returns the prepend block, e.g.:
  ```python
  def gary_capability_note(session_key: str) -> str:
      token = mint_terminal_token(session_key)
      return (
          "[terminal] A shell terminal is attached to THIS chat (cwd = workspace root); "
          "the user sees its output live in their terminal panel. To run a command in it, "
          f'shell out: `mcporter call terminal.run_command token={token} command="<cmd>"`. '
          f"Read latest output: `mcporter call terminal.read_output token={token}`. "
          "Prefer this over your own bash when the user asks you to use 'the terminal'.\n\n"
      )
  ```
  Use a stable marker prefix (like websearch's) so it can be stripped from history.
- [ ] In `app.py` `chat_stream.gen()`, alongside the existing `brain_message` mutations (~415-422): `if terminals.gary_mode_for_session(session_key): brain_message = terminals.gary_capability_note(session_key) + brain_message`.
- [ ] Add a `terminals.strip_capability_note(text)` and apply it in the history view alongside the existing strips (~app.py:531-533) so the injected block isn't shown to the user.
- [ ] Test: unit-test `gary_capability_note` contains the token + `terminal.run_command`, and `strip_capability_note(note + "hi") == "hi"`. Commit `feat(terminal): inject Gary capability hint + token per turn`.

### Task 3: Frontend toggle

**Files:** Modify `frontend-overrides/js/workspace-terminal.js`; add routes in `backend/terminals.py`.

- [ ] Backend: `GET /api/terminal/gary-mode?session_key=…` → `{global_default, override, effective}`; `POST /api/terminal/gary-mode` body `{session_key, scope:"session"|"global", enabled:bool|null}` → updates session override (via `sessions_store.set_gary_terminal`, resolving session_key→id) or global default (`websearch.save_settings({"gary_terminal_default": enabled})`). Loopback/Serve-guarded like the other routes.
- [ ] Frontend: in the panel header, add a toggle button reflecting `effective` Gary-mode for the active chat; click flips the per-chat override; long-press / a small "(global)" affordance sets the default. Fetch state on panel open + chat switch. `node --check` (NOTE: node is slow on this box; don't chain it before a git commit). Commit `feat(terminal): Gary-can-do-anything toggle in panel`.

### Task 4: MCP server + registration + docs (LIVE tree — `/Users/admin/.openclaw/workspace/`)

NOT in this repo; created directly in the live tree at deploy time (mirrors gdocs-mcp setup).

- [ ] Create `/Users/admin/.openclaw/workspace/bin/terminal-mcp.mjs` mirroring `bin/gdocs-mcp.mjs`: `new McpServer({name:'terminal',version:'0.1.0'})`; tools `run_command` (`{token:z.string(), command:z.string(), timeout:z.number().optional()}`) and `read_output` (`{token:z.string(), tail:z.number().optional()}`) and `send_keys` (`{token, data}`); each handler `await fetch('http://127.0.0.1:8800/api/terminal/mcp/<run|read|write>', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(args)})` then `ok(JSON.stringify(json))` / `fail(...)` on non-2xx (surface the 403/404 body text so Gary learns "mode off"/"expired"). `StdioServerTransport`.
- [ ] Register in `/Users/admin/.openclaw/workspace/config/mcporter.json` as `"terminal"` (copy the `docs` stdio entry; node bin + args path; description listing the 3 tools).
- [ ] Document in `/Users/admin/.openclaw/workspace/TOOLS.md` (mirror the docs section: server path, registry wiring line, per-tool `mcporter call terminal.run_command token=… command="…"` lines, a note that the user sees output live + only works when the chat's terminal mode is on) and a one-liner in `AGENTS.md`.
- [ ] Smoke: `mcporter --config /Users/admin/.openclaw/workspace/config/mcporter.json call terminal.read_output token=<a freshly minted token>` returns JSON (mint one via a quick loopback curl to a temporary mint helper, or test run_command end-to-end).

### Task 5: Deploy + live validation (user-gated)

- [ ] ff-merge `frank/terminal-gary-drive` → live branch; `scripts/sync-frontend.sh`; one workspace restart; confirm mcporter sees `terminal` server.
- [ ] **User validation:** in a web chat with terminal mode ON, ask Gary to "run `uname -a` in the terminal." Confirm: Gary calls the tool, the command + output appear in the user's terminal panel for THAT chat, and a different chat's terminal is unaffected (precise binding). Toggle mode off → Gary reports it can't.

---

## Self-review notes
- Precise binding: each turn injects a fresh token bound to that turn's `session_key`; the MCP endpoint resolves token→session, so a write lands on exactly that chat's PTY. No active-terminal heuristic. ✓ (spec hard requirement)
- Toggle: per-session override (`sessions_store`) over global default (`settings.json`), default on. ✓ (spec §4)
- Security: MCP endpoints are loopback + token-gated + mode-gated; an expired/invalid token is refused, not guessed. The token is opaque (`secrets.token_urlsafe`). ✓
- Same-PTY: human and Gary share one `PtySession` per `session_key`; the always-on reader keeps the buffer current so Gary's `read_output` works whether or not the panel is open, and Gary's writes echo into the human panel. ✓
