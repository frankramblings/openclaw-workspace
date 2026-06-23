# Handoff — 2026-06-23 (openclaw-workspace redesign)

A long session shipped a redesign SPA + many fixes (all **merged to `main`** and
pushed, merge commit `e238d25`). This doc is for a fresh session to (a) understand
the state and (b) pick up the **one significant piece of unfinished work**: making
the new "activity trail" actually show up on the user's default model (claude-cli).

## TL;DR of what's done (on `main`)

- Two coexisting frontends (both built by `scripts/sync-frontend.sh` into the
  gitignored `frontend/`, served by `uvicorn backend.app:app` on `127.0.0.1:8800`):
  - **Old design:** `frontend-overrides/index.html` → served at `/` (classic SPA:
    `frontend/js/app.js`, `chatRenderer.js`).
  - **New design ("Direction A"):** `frontend-overrides/index-redesign.html` →
    served at `/static/index-redesign.html` (redesign SPA under
    `frontend-overrides/js/redesign/`). **This is what the user uses.**
- Shipped this session: chat-history persistence + tool-card reconstruction on
  reload; the redesign is an installable PWA (`manifest-redesign.json`); empty-turn
  safeguard; model-picker bug fix; new-chat default model; doubled-reply fix;
  Cowork-style **activity trail** (collapsible 3-level disclosure + consecutive-run
  grouping); and the claude-cli reload-history fix.
- **Model config:** default chat model = `claude-opus-4-8` on the **`claude-cli`**
  endpoint (Claude subscription, plan-billed — NOT per-token). Set via
  `POST /api/default-chat` (persisted in `.data/settings.json`). The per-token
  **`anthropic`** API endpoint is hidden from the picker (`_HIDDEN_ENDPOINTS` in
  `backend/bridge.py`). The **openai/ChatGPT** path returns empty/stalls (the
  account's Plus plan doesn't serve gpt-5.4/5.5; token itself is valid) — Claude is
  the working provider. See memory files `openai-backend-empty`, `gary-dual-output`.

## THE UNFINISHED WORK: claude-cli activity-trail compatibility

**Symptom the user reported:** on `claude-opus-4-8` (claude-cli, their default), they
see *no* spinner / tool indicators live, and the Cowork activity trail never appears.
(Reload now at least keeps Gary's text replies — that part is fixed.)

**Root cause (verified):** the live relay and the history mapper were built and
verified against **OpenAI's** transcript format. claude-cli (Claude Code agent) uses
a **different shape**:
- Block types are **lowercase**: `toolcall`, `tool_result`, `thinking`, `text`
  (OpenAI uses camelCase `toolCall`/`toolResult`).
- Tool results are **inline blocks inside the assistant message** (one assistant
  message has content `[toolcall, tool_result]`), NOT separate `role:"toolResult"`
  messages.
- Thinking is a `thinking` block.

Evidence: session `agent:main:web-da42ef0d44bc` (claude-opus-4-8). Inspect its raw
transcript:
```
.venv/bin/python -c "
import asyncio, json, backend.bridge as bridge
async def m():
    r=await bridge._warm_request('chat.history',{'sessionKey':'agent:main:web-da42ef0d44bc','limit':40})
    for x in (r.get('payload') or {}).get('messages',[]):
        c=x.get('content'); sig=[(b.get('type'),b.get('name','')) for b in c if isinstance(b,dict)] if isinstance(c,list) else 'STR'
        print(x.get('role'), sig)
asyncio.run(m())"
```
You'll see assistant messages like `[('toolcall','Bash'),('tool_result','Bash')]`,
`[('thinking','')]`, `[('text','Done — ...')]`.

**What to do (two parts):**

1. **Reload path — `_map_history` in `backend/bridge.py`** (well unit-tested in
   `backend/tests/test_bridge.py`). Today it only recognizes camelCase `toolCall`
   blocks and separate `role:"toolResult"` messages. Extend it to ALSO handle:
   - lowercase `toolcall` blocks (tool call), `tool_result` blocks **inline** in
     assistant content (pair them within the same/adjacent message), and `thinking`
     blocks. Produce the same `tool_events` (`{round, tool, command, output,
     exit_code}`) + `round_texts` the renderer already consumes. (This also delivers
     the spec's **thinking-on-reload** fast-follow, since claude-cli stores thinking.)
   - Add test fixtures mirroring the lowercase/inline claude-cli shape. Keep the
     existing OpenAI tests green.
   - Verify against the real session via `bridge.fetch_history(...)` (note: the WS
     path is what `/api/history` first page uses now — see "history source" below).

2. **Live path — `_relay_events` in `backend/bridge.py`.** It maps gateway `agent`
   stream items (`kind` in `{command, tool}`) to `tool_start`/`tool_output` SSE, and
   `analysis` items to thinking deltas. For claude-cli these item kinds/shapes likely
   differ, so no events are emitted. **First capture the raw gateway frames from a
   live claude-cli tool turn**, then map them. Capture pattern:
   ```
   PYTHONPATH=. .venv/bin/python -c "
   import asyncio, json, backend.bridge as bridge
   async def m():
       ws,run_id,_=await bridge._open_turn('Run: echo hi (use your bash tool)','agent:main:web-dbgcli','claude-cli/claude-opus-4-8',None,{},False)
       import time; t0=time.time()
       while time.time()-t0<40:
           try: f=await asyncio.wait_for(bridge._recv_json(ws),timeout=5)
           except: continue
           if f.get('type')=='event': print(json.dumps(f)[:300])
   asyncio.run(m())"
   ```
   NOTE: getting claude-cli to actually invoke the agent **bash tool** (vs. the
   attached terminal) may take an explicit prompt. The **attached terminal** (right
   "Terminal · Files" panel) is a *separate channel* that emits no agent tool events
   — those turns will never show tool cards, by design.

**The renderer side is DONE and correct** — do not rebuild it. `chat-activity-group.js`
(grouping/summary), `renderActivity`/`renderWorking`/`renderItem` in `chat-activity.js`,
the 3-level collapse state in `app.js`, and the CSS are merged and unit-tested (20
frontend tests). The frontend live path (`live/chat.js` `onEvent`) already consumes
`tool_start`/`tool_output`, and `historySteps` already builds the trail from backend
`tool_events`. Once the backend emits/reconstructs claude-cli events, the trail shows.

Spec + plan for the trail: `docs/superpowers/specs/2026-06-23-activity-trail-cowork-parity-design.md`,
`docs/superpowers/plans/2026-06-23-activity-trail-cowork-parity.md`.

## Other gotchas discovered (so you don't re-learn them)

- **History source:** the gateway's HTTP history endpoint (`/sessions/:key/history`)
  **truncates some sessions** (a claude-cli session returned only 1 message → replies
  vanished on reload). `GET /api/history` now reads the **first page from WS
  `chat.history`** (`bridge.fetch_history`, reliable for all providers) and only uses
  HTTP for older-than-cursor pages. Trade-off: WS first page is tail-only (~1000 msg
  window), so extremely long transcripts won't lazy-load older pages.
- **Doubled replies:** Gary's agent emits both a `message`-tool delivery AND a final
  reply. Fixed **live** via a `reply_reset` SSE (relay emits it on a new mid-turn
  message; redesign `live/chat.js` clears the turn's text). On **reload** both
  assistant texts still render (reply_reset is live-only) — minor, could mirror the
  same "keep last message" logic in `_map_history` as a follow-up.
- **Terminal-attach** records the user's prompt twice; `GET /api/history` dedups
  consecutive identical user messages after stripping the terminal-control note.
- The classic SPA does **not** handle `reply_reset` (so it can still double on
  message-tool turns) — known, intentionally not fixed.

## Operational reference

- **Run/serve:** `uvicorn backend.app:app --host 127.0.0.1 --port 8800` (currently
  running, no `--reload`). **Restart after backend edits.** Frontend edits need
  `scripts/sync-frontend.sh` (then served statically, no restart). Bump shows in the
  served `/sw.js` CACHE_NAME; tell the user to **hard-refresh** (service worker).
- **Backend tests:** `.venv/bin/python -m pytest backend/tests/ -q` (535 pass).
  `backend/` is a package; run from repo root or `PYTHONPATH=.` (there's a
  `backend/calendar.py` that shadows stdlib if `backend/` is on `sys.path` directly).
- **Frontend tests:** `cd frontend-overrides/js && node --test '__tests__/*.test.js'`
  (20 pass; Node built-in runner, ESM; the redesign renderer is pure-string and
  node-importable, so unit-test HTML output directly).
- **Headless verify:** Playwright at
  `/home/frank/code/openclaw/node_modules/playwright/index.js`, chromium at
  `/snap/bin/chromium`, against `http://127.0.0.1:8800/static/index-redesign.html`.
  Use `waitUntil:'domcontentloaded'` (the SPA holds a WS open, so `networkidle`
  never fires).
- **Gateway ("brain"):** WS on `127.0.0.1:18789`. Sessions metadata in
  `.data/sessions.json` (shape `{"sessions":[ {id, sessionKey, model, endpoint_id,
  ...} ]}`). Transcripts live in the gateway, read via `chat.history` (WS) /
  `/sessions/:key/history` (HTTP).
- **Host:** naboo (headless, Linux), accessed over Tailscale
  (`naboo.bicolor-triceratops.ts.net`, 100.80.66.76). For the brainstorm visual
  companion, bind `--host 0.0.0.0 --url-host naboo.bicolor-triceratops.ts.net`.
- **Git:** on `main` (merged + pushed, `e238d25`). The merged branch
  `redesign/direction-a-refined-charcoal` still exists (local + origin). **Start new
  work on a fresh branch off `main`.** Commit msg footer convention:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Memory:** `~/.claude/projects/-home-frank-openclaw-workspace/memory/` —
  `gary-dual-output.md`, `openai-backend-empty.md`, `MEMORY.md`.

## Suggested next-session opening move

Confirm with the user, then: branch off `main`, capture a live claude-cli tool turn's
raw frames (command above), and do the `_map_history` (reload) + `_relay_events`
(live) claude-cli format support with tests. That's the one thing standing between the
finished activity trail and the user actually seeing it.
