# Attached Terminal — design

**Date:** 2026-06-16
**Status:** approved design, pre-implementation
**Surface:** openclaw-workspace (FastAPI backend + Odysseus/Hermes frontend overlay)

## Summary

A right-side terminal panel, attached per chat session, mirroring the existing
file-explorer panel. Each chat gets one real interactive PTY (cwd = workspace
root). The user can type into it directly (xterm.js over a WebSocket), and Gary
can drive the *same* shell via an MCP tool. A per-chat "Gary can do anything
here" mode (default **on**, with a global default and per-chat override) gates
whether Gary's writes are accepted.

## Context & constraints

- **Stack reality:** workspace backend is **Python/FastAPI** (one router per
  feature, included in `backend/app.py`). The OpenClaw-core `node-pty` terminal
  branch found in `tmp/openclaw-terminal-model` (now deleted; reference saved to
  `~/.openclaw/terminal-branch-salvage/`) is **design reference only** — its PTY
  code does not port. Its `controlMode` (gary/view) and per-session settings
  design *do* port.
- **Access path (load-bearing for security):** the user reaches the workspace
  **exclusively** via `https://bespin…ts.net:8443` → Tailscale Serve → terminates
  TLS → forwards to `127.0.0.1:8800`. The backend's socket peer for all
  legitimate traffic is therefore **`127.0.0.1`**, never the `100.x` tailnet
  address. See `reference_workspace_access` memory.
- **Frontend pattern:** panels are self-contained IIFE overlays (no module
  imports), tolerant of a missing backend route (pane stays hidden), using
  `localStorage` for client state. Right-side panels register an entry in the
  `PANELS` map in `frontend-overrides/js/hermes-panels.js`. Mirror
  `workspace-explorer.js`.
- **Agent integration pattern:** Gary reaches local tools via `mcporter` from
  bash, with servers registered in `config/mcporter.json` (the gdocs-mcp /
  ramblebot / Slack pattern).
- **Verification constraint:** no headless Chrome on this box (`feedback_no_headless_chrome`).
  Verify via `node --check` + curl handshakes + user eyeballs on the 8443 origin.

## Goals

- Interactive terminal in a right-side panel, attached per chat session.
- Default cwd = workspace root.
- Human types directly **or** Gary drives the same shell.
- "Gary can do anything here" mode: default on, global default + per-chat override.
- Terminal surface reachable only through the tailnet front door (loopback-only).

## Non-goals (v1)

- Multiple terminals per chat (one PTY per chat; multi-tab is a later add).
- PTY persistence across backend restarts (ephemeral; restart ⇒ fresh spawn).
- Mobile-optimized terminal UX (panel works on mobile but is desktop-first).
- Sandboxing/permission prompts on individual commands (the toggle is the gate).

## Architecture

### 1. PTY backend — `backend/terminals.py`

In-memory registry `session_key → PtySession`. `PtySession` wraps a real PTY
(stdlib `pty.openpty()` + `$SHELL`, `cwd` = workspace root), an asyncio read
loop draining the master fd, and a rolling **~120k-char scrollback buffer** for
re-attach. Methods: `open / write / resize / close`; emits an exit event when the
child dies (captures exit code). Lazy: a session spawns on first panel-open (or
first Gary write) for that chat; it dies on explicit close or backend restart.

> Implementation note: if stdlib `pty` + non-blocking master-fd reads prove
> fiddly under uvicorn's loop, fall back to `ptyprocess` (small, well-supported).
> Decide during implementation; either keeps the same `PtySession` interface.

### 2. Transport — `WS /api/terminal/{session_key}/stream`

Bidirectional WebSocket on the FastAPI router:
- server→client: `{type:"output", data}` frames; `{type:"exit", code}` on death.
- client→server: `{type:"input", data}` and `{type:"resize", cols, rows}`.
- On connect, replays the scrollback buffer so a reopened panel is continuous.

**Security guard (loopback-only):** the WS handler accepts the connection only
when the socket peer is `127.0.0.1`. This permits 100% of real traffic (it all
arrives through Serve as loopback) and rejects any LAN device hitting `:8800`
directly (those carry a `192.168.x` peer). Optional belt-and-suspenders: also
require the `Tailscale-User-Login` header Serve injects, so only requests through
the tailnet front door qualify (not just any local process). File-explorer and
other routes keep their current LAN-open posture — only the terminal surface is
hardened.

### 3. Frontend panel — `frontend-overrides/js/workspace-terminal.js`

Self-contained IIFE overlay mirroring `workspace-explorer.js`:
- Vendored **xterm.js + fit addon** (vendoring third-party is precedented — the
  explorer lifts MIT hermes-webui blocks). No CDN (respects SW/offline posture).
- Registers a `PANELS` entry in `hermes-panels.js` (right-side, resizable) + a
  strip launch button + layout CSS.
- **Same-origin WS URL built from `location`**: `wss://<host>:8443/api/terminal/
  <session_key>/stream`. Never hardcode `:8800`.
- Auto-reconnect with scrollback replay on open; fit-addon resize → `{resize}`
  frame. Header controls: **Gary mode** toggle (this chat) + link to global
  default, restart, close.
- Degrades gracefully: if `/api/terminal/*` is absent, the pane stays hidden
  (matches explorer's tolerance of a backend that lacks its route).

### 4. "Gary can do anything here" state

- **Global default** (on) + **per-chat override**, persisted via the existing
  settings store; per-chat override keyed by `session_key`.
- Semantics: mode **on** ⇒ Gary's writes into this chat's PTY are accepted; mode
  **off** ⇒ the MCP/HTTP write path 403s and the panel is human-only.
- The backend is the source of truth for the effective mode (frontend toggle and
  MCP write path both consult it), so the human panel and Gary stay consistent.

### 5. Gary-drive via MCP — `terminal-mcp`

A small stdio MCP server (Node, mirroring `bin/gdocs-mcp.mjs`), registered in
`config/mcporter.json`. Tools: `terminal_open`, `terminal_write`, `terminal_read`
(recent buffer / since-cursor), `terminal_run` (write + await quiet + return
output), `terminal_close`. It calls the FastAPI terminal REST over **`127.0.0.1`**
against the *same* registry, so Gary's commands and their output stream into the
user's panel live.

**Implicit session→terminal resolution (no injected id):** the MCP tools do not
require a terminal id. The backend resolves "this chat's terminal" implicitly:
- Preferred: derive the workspace session from the agent's run context if the
  gateway exposes it to the tool environment (**verify availability during
  implementation**).
- Fallback for single-user v1: the backend's currently-active terminal (the
  most-recently-active chat's PTY). Acceptable because it's one user driving one
  chat at a time; can misfire only if the user chats in B while the panel is on A.
- An explicit `session_key` argument remains available on the tools for
  correctness/testing, but is optional.

### 6. Bridge capability hint — `backend/bridge.py`

When Gary-mode is on for a session, the bridge injects a lightweight one-line
capability hint into the outgoing `chat.send` turn: *"A terminal is attached to
this chat; use the `terminal` MCP tools to run commands in it (cwd = workspace
root)."* No id (implicit resolution handles targeting). Pair with an AGENTS.md /
skill nudge so Gary reaches for it. This is the **highest-integration-risk seam**
— validate that the hint reliably reaches the turn and that Gary discovers/uses
the tool.

## Data flow

- **Human:** xterm keystroke → `{input}` WS frame → `PtySession.write` → shell →
  master fd → `{output}` WS frame → xterm render.
- **Gary:** chat turn (mode on) → bridge injects capability hint → Gary runs
  `mcporter call terminal_write …` → `terminal-mcp` → POST `127.0.0.1` FastAPI →
  resolve session → `PtySession.write` → output streams to the human panel too.

## Error handling / edges

- PTY child exits → `{exit, code}` frame → panel shows "exited (code)" + restart.
- Backend restart → PTY registry empty → panel reconnect finds none → offers
  fresh spawn.
- WS drop → panel auto-reconnects and replays scrollback.
- Gary write while mode off → 403; the MCP tool returns "remote control disabled".
- Non-loopback peer (LAN device on `:8800`) → connection refused.
- `/api/terminal/*` absent → panel hidden, no errors (graceful degrade).

## Testing

Respecting "no headless Chrome on this box":
- **pytest** (`backend/tests`): `PtySession` spawn `echo`/write/buffer/resize/
  close/exit; WS loopback guard rejects a simulated non-loopback peer; effective
  Gary-mode resolution (global default vs per-chat override); MCP write 403s when
  mode off.
- **MCP unit test:** a `terminal_write` routes into the registry and the bytes
  reach the PTY (implicit resolution targets the active session).
- **Manual smoke:** `node --check` the new JS; curl the WS upgrade handshake and
  the terminal REST; confirm Tailscale Serve forwards the WS upgrade for
  `/api/terminal/*` on the 8443 origin; user eyeballs the panel.

## Phasing

- **PR 1 — human-interactive terminal:** §1 PtySession, §2 WS + loopback guard,
  §3 panel, §4 mode state. Standalone value: a real attached terminal you can type
  in.
- **PR 2 — Gary-drive:** §5 terminal-mcp + REST, §6 bridge hint + AGENTS/skill
  nudge. Lights up "have Gary drive it".

## Open risks

1. **§6 discovery/use** — does the capability hint reliably reach Gary's turn and
   does Gary actually pick up the MCP tool? Highest risk; validate early in PR 2.
2. **Agent session exposure (§5)** — whether the gateway exposes the workspace
   session to the MCP tool environment determines precise vs. active-terminal
   resolution. Verify during PR 2; fallback is acceptable for single-user v1.
3. **PTY under uvicorn loop** — stdlib `pty` master-fd async reads vs.
   `ptyprocess`; pick during PR 1 behind the `PtySession` interface.
4. **Serve WS passthrough** — confirm Tailscale Serve proxies the WS upgrade for
   the terminal path before declaring PR 1 done.
