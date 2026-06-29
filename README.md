# OpenClaw Workspace

<div align="center">
  <img src="docs/assets/hero.png" alt="OpenClaw Workspace" width="100%">
</div>

**A personal AI command center.** A scored inbox that triages Gmail, Slack & Asana, a full email client, calendar, multi-step research, notes, and streaming chat — all talking to your own [OpenClaw](https://github.com/openclaw/openclaw) agent, from any browser.

[![CI](https://github.com/frankramblings/openclaw-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/frankramblings/openclaw-workspace/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-4fe3d1.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-4fe3d1.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/backend-FastAPI-4fe3d1.svg)](https://fastapi.tiangolo.com)
[![Docker](https://img.shields.io/badge/docker-compose-4fe3d1.svg)](docker-compose.yml)

[Quickstart](#quickstart) · [Surfaces](#surfaces) · [Architecture](#architecture) · [Security](#security) · [Config](#config)

> OpenClaw is the brain — model routing, memory, tools, skills, web search.  
> **This is the place you talk to it**, from any browser, across every surface you actually work in.

You name your agent once at setup. That name propagates everywhere: the app icon, the title bar, the chat header, your terminal prompt.

**Why this exists.** Most agent UIs are a lone chat box; this one wires your agent into the surfaces you actually work in — inbox, mail, calendar, research, notes — so it can _act_, not just answer.

## Surfaces

<table>
<tr>
<td width="50%"><img src="docs/screenshots/chat.png" alt="Chat"></td>
<td width="50%"><img src="docs/screenshots/inbox.png" alt="Inbox"></td>
</tr>
<tr>
<td width="50%"><strong>Chat</strong> — Streaming conversations with live tool-call cards, a model picker reading the real gateway catalog, and a <code>/commands</code> palette.</td>
<td width="50%"><strong>Inbox</strong> — A scored triage feed across Gmail, Slack, Asana &amp; meeting notes. Sorted by <em>needs you</em> vs. <em>FYI</em>; the agent suggests archive or reply.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/email.png" alt="Email"></td>
<td width="50%"><img src="docs/screenshots/calendar.png" alt="Calendar"></td>
</tr>
<tr>
<td width="50%"><strong>Email</strong> — A full mailbox: read, search, threaded reply, send. One tap to AI-draft, AI-reply, or summarize a thread.</td>
<td width="50%"><strong>Calendar</strong> — Month / week / agenda over Google or CalDAV. Natural-language quick-add: <em>"lunch with Sam tue 1pm."</em></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/research.png" alt="Research"></td>
<td width="50%"><img src="docs/screenshots/notes.png" alt="Notes"></td>
</tr>
<tr>
<td width="50%"><strong>Research</strong> — Multi-step web research with configurable rounds and cited inline sources <code>[n]</code>.</td>
<td width="50%"><strong>Notes</strong> — A markdown vault shared with the agent. Your edits are agent-visible and vice versa, with version history + restore.</td>
</tr>
</table>

Two more round it out — **Library** (an indexed store of everything the agent has written or you've uploaded) and **Settings** (connect Ollama, Anthropic, OpenAI, DeepSeek, Groq, and toggle integrations).

> **Tabs that aren't configured hide themselves.** A fresh install with only OpenClaw shows just Chat.

## Architecture

```
OpenClaw gateway (ws://)
        │
  bridge.py  ←─── the load-bearing piece: WS → SSE, streams tool calls live
        │
  FastAPI /api  ─── per-tab adapters (email, calendar, inbox, notes, cron…)
        │
  Vanilla JS SPA  ─── frontend-overrides/ layered onto frontend-vendor/
```

The bridge is the heart of it: it renders every tool call the moment it fires — no polling, no page reload — while keeping you on your flat-rate OpenClaw plan rather than per-token API billing.

## Quickstart

```bash
# clone & enter
git clone https://github.com/frankramblings/openclaw-workspace openclaw-workspace
cd openclaw-workspace

# 1 — Name your agent and bake the frontend
scripts/setup.sh                      # interactive

# 2 — Install deps
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt

# 3 — Run
uvicorn backend.app:app --port 8800   # → http://127.0.0.1:8800
```

Prefer one command? `scripts/dev.sh` creates the venv, installs deps, and runs with hot-reload.

<details>
<summary>Docker</summary>

```bash
cp .env.example .env           # set gateway WS + password
docker compose up --build      # → http://127.0.0.1:8800
```

</details>

<details>
<summary>Run on boot (macOS)</summary>

```bash
scripts/install-launchagent.sh        # 127.0.0.1:8800, auto-restart
```

</details>

## Security

By default the port binds to `127.0.0.1` — **not reachable from the LAN**. The recommended remote-access path is **Tailscale Serve** in front of `127.0.0.1:8800`.

> ⚠️ The token gate covers HTTP only. The terminal PTY WebSocket is gated by your reverse proxy. Don't expose the workspace on an untrusted network on the strength of a token alone — **the terminal is a real shell.**

## Config

| Variable | Default | Purpose |
|---|---|---|
| `WORKSPACE_AGENT_NAME` | from branding | Agent display name everywhere |
| `WORKSPACE_ACCENT` | `#4fe3d1` | Theme accent color |
| `WORKSPACE_SOURCE_URL` | upstream repo | Source link shown in the UI (AGPL §13). **Forks must point this at their own repo.** |
| `OPENCLAW_GATEWAY_WS` | from `openclaw.json` | Gateway WebSocket URL |
| `OPENCLAW_DEFAULT_MODEL` | `agents.list[0]` | Model for new chats |

---

[AGPL-3.0](LICENSE) © The OpenClaw Workspace authors — see [NOTICE](NOTICE)  
Built on [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) (AGPL-3.0) · talks to your [OpenClaw](https://github.com/openclaw/openclaw) agent · powered by [FastAPI](https://fastapi.tiangolo.com)
