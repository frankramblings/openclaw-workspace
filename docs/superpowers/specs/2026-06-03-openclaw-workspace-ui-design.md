# OpenClaw Workspace UI — v1 Design Spec

**Date:** 2026-06-03
**Status:** Approved for v1 scaffold

## Goal

A single-context web "workspace shell" over OpenClaw, so the user (ADHD, currently
interacting via Signal) can triage, steer, and write in one browser tab instead of
fragmenting attention across Signal + six apps. OpenClaw is already a working
"external brain" (memory + connectors for email/Slack/Asana/calendar/Granola-Obsidian);
the missing piece is the front-of-house.

## Hard constraint

**Subscription pricing only — no API-key billing.** All inference must route through
OpenClaw's gateway, which runs the codex agent on a ChatGPT-subscription OAuth token.
This is *the* reason we don't run our own agent loop and don't use any OpenAI/Anthropic
API key.

## Strategy: reuse our own parts, build only the glue

We are NOT building a UI from scratch and NOT assembling several third-party UIs.
We reuse three things that already exist and work:

| Piece | Source | Role |
|---|---|---|
| **Brain** | OpenClaw gateway (`ws://127.0.0.1:18789`) | inference + tools + memory, at subscription rate |
| **Chassis** | Odysseus (`/Users/admin/odysseus`) — `static/` SPA + FastAPI `/api` | chat UI, tool panels, doc workspace, tabs |
| **Inbox data** | OpenClaw triage-dashboard (`workspace/triage-dashboard/api`) | `merged.js` already aggregates gmail+slack+asana+granola into one scored feed |

Net-new code is two pieces of glue:
1. **The bridge** — replaces Odysseus's `src/agent_loop.py` (OpenAI brain) with an
   OpenClaw gateway WS client that relays events into Odysseus's SSE shape. This is
   also what lights up the tool-call panels.
2. **The inbox proxy** — exposes the triage feed to the new backend.

## Architecture

```
 Odysseus static/ SPA  (copied into frontend/)
   │  POST /api/chat_stream (multipart form: message, session)   ← unchanged frontend
   ▼
 backend/app.py (FastAPI)
   ├─ /api/chat_stream  → bridge.py ─ WS ─► OpenClaw gateway :18789   (REAL, v1)
   ├─ /api/items        → inbox.py  ─ HTTP ─► triage-dashboard :3456  (proxy, v1)
   └─ minimal stubs (/api/sessions, /api/models, /api/chat/resume…)   so the SPA loads
```

### The bridge contract (verified against OpenClaw + Odysseus source)

**Gateway side (consume):**
- Connect: open WS, receive `{event:"connect.challenge", payload:{nonce}}`, then send
  `{type:"req", method:"connect", params:{minProtocol:3, maxProtocol:3, client:{…},
  role:"operator", auth:{token:<gateway password>}}}`. `controlUi.allowInsecureAuth:true`
  means no device ed25519 signature is required — the shared password is enough.
- Send turn: `{type:"req", method:"chat.send", params:{sessionKey, message, deliver:false,
  idempotencyKey}}` → ack `{ok:true, payload:{runId, status:"started"}}`.
- Receive (filter by `runId`):
  - `event:"chat"`, `payload.state:"delta"|"final"`, text at `payload.message.content[0].text`
    (CUMULATIVE — bridge diffs against last length to emit incremental chunks).
  - `event:"agent"`, `payload.stream:"tool"`, `data.phase:"start"` (`name`,`args`) / `"end"` (`result`).
  - `event:"agent"`, `payload.stream:"lifecycle"`, `data.phase:"end"` → turn done.

**Odysseus side (emit as SSE `data: {json}\n\n`):**
- `{"delta":"<chunk>"}` for assistant text.
- `{"type":"tool_start","tool":<name>,"command":<args-json>,"round":1}`.
- `{"type":"tool_output","tool":<name>,"output":<result-json>,"exit_code":0}`.
- terminal literal `data: [DONE]\n\n`.

### Session targeting

`chat.send` takes a `sessionKey`. Default to `agent:main:main` (the canonical agent
session, shared with the Signal channel so memory/context carry over). Overridable via
`OPENCLAW_SESSION_KEY`. **Needs a live smoke-test** to confirm the gateway accepts a
caller-supplied session key vs. the connection-scoped one.

### Secrets

The gateway password is read at runtime from `~/.openclaw/openclaw.json`
(`gateway.auth.password`) — never copied into this repo. Overridable via env.

## v1 scope (what this scaffold delivers)

- ✅ **Chat tab works end-to-end**: Odysseus UI → bridge → OpenClaw codex brain →
  streamed reply **with live tool-call panels**. This proves the entire thesis.
- ✅ Inbox **backend** ready (proxy to triage feed).
- ⚠️ Inbox **frontend** wiring is a follow-up: Odysseus's inbox view calls `/api/email/*`
  (its own IMAP), not `/api/items`. Surfacing the unified triage feed needs either a
  small data-shape adapter or a new inbox view — explicitly deferred, not done here.
- ⚠️ Other Odysseus tabs (docs/notes/research/etc.) are inert until their `/api` is
  ported/proxied — that's v2.

## Phases beyond v1

- **v2** — agent can *act*: thin OpenClaw proxy-skills calling Odysseus `/api` (send mail,
  edit notes); wire the Inbox view to the triage feed; port doc/notes endpoints.
- **v3** — the genuinely new builds: doc-editing agent tool; self-updating-skills loop
  (feedback → propose → human gate → write); curated-fact memory overlay (port Odysseus's
  `memory.json` typed-facts model onto OpenClaw's `memory-core` RAG).

## Risks / open items

1. **Live smoke-test of the bridge** — event field shapes were read from source + tests;
   confirm against a real turn (esp. `message.content[0].text` cumulative behavior and
   session-key acceptance).
2. **One concurrent turn per WS** — v1 opens a fresh gateway WS per chat request (simple,
   slightly wasteful). Fine for single-user PoC.
3. **Frontend expects endpoints we stub** — stubs must return shapes that don't throw in
   the SPA's JS. Chat + load path only; everything else best-effort.
```
