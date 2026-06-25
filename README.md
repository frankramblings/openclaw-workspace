# OpenClaw Workspace

**A personal AI command center** — chat with live tool-call panels, a real inbox, email client, calendar, research, notes, and more, all talking to your [OpenClaw](https://github.com/openclaw/openclaw) brain at subscription pricing (no per-token API key).

[![CI](https://github.com/frankramblings/openclaw-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/frankramblings/openclaw-workspace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-4fe3d1.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-4fe3d1.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/backend-FastAPI-4fe3d1.svg)](https://fastapi.tiangolo.com)
[![Docker](https://img.shields.io/badge/docker-compose-4fe3d1.svg)](docker-compose.yml)

<br>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/chat.png" alt="Chat — streaming conversations with tool-call cards" /></td>
<td width="50%"><img src="docs/screenshots/inbox.png" alt="Inbox — scored triage feed across Gmail, Slack, and Asana" /></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/calendar.png" alt="Calendar — month/week/agenda with natural-language quick-add" /></td>
<td width="50%"><img src="docs/screenshots/email.png" alt="Email — full client with AI reply and summarize" /></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/research.png" alt="Research — multi-step web research with cited sources" /></td>
<td width="50%"><img src="docs/screenshots/notes.png" alt="Notes — markdown vault with versioning and history" /></td>
</tr>
</table>

<br>

## What it is

OpenClaw is the brain (model routing, memory, tools, skills, web search). This is a place to talk to it — from any browser, across every surface you actually work in.

You name your agent once at setup. The maintainer's is **Gary**. That name propagates everywhere: the app icon, the title bar, the chat header, your terminal prompt.

## Surfaces

| Surface | What it does |
|---|---|
| **Chat** | Streaming conversations with live tool-call cards, a model picker reading the real gateway catalog, and a `/commands` palette |
| **Inbox** | Scored triage feed — Gmail + Slack + Asana + meeting notes, sorted by what needs you vs. FYI. AI suggests archive or reply. |
| **Email** | Full mailbox via `himalaya` — read, search, threaded reply, send. One-tap AI draft, AI reply, or AI summarize. |
| **Calendar** | Month/week/agenda view (Google or CalDAV). Natural-language quick-add: _"lunch with Sam tue 1pm"_ |
| **Research** | Multi-step web research with configurable rounds and cited inline sources `[n]` |
| **Notes** | Markdown vault shared with the agent. Edits you make are agent-visible and vice versa. Version history + restore. |
| **Library** | Indexed document store — search, open, manage files the agent has written or you've uploaded |
| **Settings** | Connect models — local Ollama, Anthropic, OpenAI, DeepSeek, Groq, and more. Toggle integrations. |

Tabs that aren't configured hide themselves. A fresh install with only OpenClaw shows only Chat.

## Architecture

```
OpenClaw gateway (ws://)
        │
  bridge.py  ←─── the load-bearing piece: WS→SSE, streams tool calls live
        │
  FastAPI /api  ─── per-tab adapters (email, calendar, inbox, notes, cron…)
        │
  Vanilla JS SPA  ─── frontend-overrides/ layered onto frontend-vendor/
```

The bridge keeps you on subscription pricing *and* renders every tool call the moment it fires — no polling, no page reload.

## Quickstart

```bash
git clone https://github.com/frankramblings/openclaw-workspace openclaw-workspace
cd openclaw-workspace

# 1. Name your agent and bake the frontend
scripts/setup.sh                      # interactive
# or: scripts/setup.sh --name Aria --yes

# 2. Install deps
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt

# 3. Run
uvicorn backend.app:app --port 8800
# → http://127.0.0.1:8800
```

Or use the one-command dev runner (creates the venv, installs deps, hot-reload):

```bash
scripts/dev.sh
```

### Docker

```bash
cp .env.example .env           # set OPENCLAW_GATEWAY_WS + OPENCLAW_GATEWAY_PASSWORD
docker compose up --build
# → http://127.0.0.1:8800
```

Set `WORKSPACE_AGENT_NAME=Aria` in `.env` to rename without re-running setup.

### Run on boot (macOS)

```bash
scripts/install-launchagent.sh        # 127.0.0.1:8800, auto-restart on crash
```

On Linux, run the same `uvicorn` command from a systemd unit.

## Requirements

- A running **OpenClaw** install with its gateway up (default `ws://127.0.0.1:18789`)
- **Python 3.11+** (developed on 3.14)
- macOS or Linux

Email, Calendar, and Inbox each need their own account wiring — they're optional. Chat works with just OpenClaw.

## Optional integrations

```bash
scripts/setup.sh --add-email          # Gmail app-password or IMAP/SMTP
scripts/setup.sh --add-calendar       # Google OAuth or any CalDAV provider
scripts/setup.sh --enable inbox       # unified triage feed (Gmail + Slack + Asana)
```

Run `scripts/doctor.sh` to verify your gateway connection at any time.

## Connecting to a remote OpenClaw

```bash
# Same-host: reads ~/.openclaw/openclaw.json automatically — nothing to configure
# Remote:
export OPENCLAW_GATEWAY_WS=ws://host:18789
export OPENCLAW_GATEWAY_PASSWORD=...
```

## Security

By default the port is bound to `127.0.0.1` — not reachable from the LAN.

Recommended remote-access path: **Tailscale Serve** in front of `127.0.0.1:8800`.

To require a token on every request (needed if you expose the port beyond localhost):

```bash
export WORKSPACE_AUTH_TOKEN=your-long-random-secret
# Visit http://host:8800/?token=... once — sets an HttpOnly cookie for the session
```

> The token gate covers HTTP only. The terminal PTY WebSocket is gated by your reverse proxy (e.g. Tailscale identity). Don't expose the workspace on an untrusted network on the strength of a token alone — the terminal is a real shell.

## Key env vars

| Variable | Default | Purpose |
|---|---|---|
| `WORKSPACE_AGENT_NAME` | from `.data/branding.json` | agent display name everywhere |
| `WORKSPACE_ACCENT` | `#4fe3d1` | theme accent color |
| `WORKSPACE_AUTH_TOKEN` | _(none)_ | bearer token for HTTP auth |
| `OPENCLAW_GATEWAY_WS` | from `openclaw.json` | gateway WebSocket URL |
| `OPENCLAW_GATEWAY_PASSWORD` | from `openclaw.json` | gateway auth |
| `OPENCLAW_DEFAULT_MODEL` | `agents.list[0].model` | model for new chats |

Full annotated list: [`.env.example`](.env.example)

## Tests

```bash
. .venv/bin/activate && python -m pytest backend/tests -q
```

## Layout

```
backend/              FastAPI app + gateway bridge
  app.py              routes, serves the SPA, /api/config, /api/chat_stream
  bridge.py           OpenClaw gateway WS → frontend SSE  ← the heart of it
  config.py           runtime config (reads ~/.openclaw/openclaw.json + branding)
  inbox/              unified-feed collectors (gmail/slack/asana/obsidian)
  *.py                per-tab adapters (email, calendar, notes, documents, cron…)
frontend-vendor/      neutral SPA base, committed (sync source of truth)
frontend/             build output: vendor + overrides, name-baked (gitignored)
frontend-overrides/   durable workspace customizations layered onto the SPA
scripts/              setup · sync-frontend · doctor · install-launchagent
docs/                 design specs, plans, SHIPPING.md
```

## Forking

`.data/` (your agent name + branding) and `frontend/` (the baked build) are gitignored, so personal config stays out of git. To share a clean history:

```bash
scripts/prepare-public.sh    # builds a single-commit `public` branch
```

## License

[MIT](LICENSE) © The OpenClaw Workspace authors
