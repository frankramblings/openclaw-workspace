# OpenClaw Workspace

A single-context **web workspace** for your [OpenClaw](https://github.com/openclaw/openclaw)
agent — chat with live tool-call panels, a unified inbox, an email client, a
calendar, notes, documents, scheduled jobs, memory, and skills, all driven by
OpenClaw's gateway brain at **subscription pricing** (no per-token API key).

You name your agent once at setup — the maintainer's is **Gary** — and that name
shows up everywhere: the title bar, chat header, message box, app icon.

> Built on top of OpenClaw, not a replacement for it. OpenClaw is the brain
> (model access, memory, tools, skills); this is a comfortable place to talk to it.

## Why it exists

Chatting with an agent through one channel (Signal, a terminal) is fine but
fragmented. This gives you **one place** to triage what's coming in, steer the
agent, and get work done — without giving up OpenClaw's subscription-rate
inference or its tool ecosystem.

It reuses three things that already work and adds only the glue:

- **Brain** — OpenClaw's gateway over WebSocket. The bridge (`backend/bridge.py`)
  speaks the gateway protocol and re-emits events as the SSE the frontend
  expects, which is what keeps you on subscription pricing *and* renders tool
  calls live.
- **Chassis** — a backend-agnostic vanilla-JS SPA served by a FastAPI `/api`
  shell. Workspace-specific UI lives in `frontend-overrides/` and is layered on
  at sync time (see that folder's README).
- **Data** — your existing accounts (Gmail/Slack/Asana via the inbox collectors,
  himalaya for email, Google Calendar) surfaced through thin backend adapters.

## Requirements

- A running **OpenClaw** install with its gateway up (default `ws://127.0.0.1:18789`).
  The workspace reads the gateway password and default model from
  `~/.openclaw/openclaw.json` — secrets never live in this repo.
- **Python 3.11+** (developed on 3.14).
- macOS or Linux. The "run on boot" helper is macOS-only (LaunchAgent); on Linux
  use a systemd unit running the same uvicorn command.

The Email, Calendar, and Inbox-collector tabs each need their own account wiring
and are optional — chat works with just OpenClaw.

## Quickstart

```bash
git clone <this-repo> openclaw-workspace && cd openclaw-workspace

# 1. Name your agent + prepare the frontend
scripts/setup.sh                      # interactive — asks for the name
#   or: scripts/setup.sh --name Gary --yes

# 2. Install deps
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt

# 3. Run
uvicorn backend.app:app --port 8800
#   → open http://127.0.0.1:8800
```

Or skip steps 2–3 with the one-command dev runner (creates the venv, installs
deps, builds the frontend if needed, then runs with `--reload`):

```bash
scripts/dev.sh
```

Rename your agent any time with `scripts/setup.sh --name <NewName>` (re-bakes the UI).

### Run on boot (macOS)

```bash
scripts/install-launchagent.sh        # 127.0.0.1:8800, restarts on crash
```

## Security model

There is **no app-level authentication** by design — it's built for a single
user, and the network is the boundary. So:

- Bind to **`127.0.0.1`** (the default) and reach it remotely over a private
  network. The recommended path is Tailscale:
  `tailscale serve --bg --https=8443 127.0.0.1:8800`.
- **Do not** bind `0.0.0.0` on an untrusted LAN. The agent has shell access, so
  an open port is effectively root on your box.

## Configuration

Everything has a sensible default. Override via environment variables — see
[`.env.example`](.env.example) for the full annotated list. The headline ones:

| Variable | Default | Purpose |
|---|---|---|
| `WORKSPACE_AGENT_NAME` | from `.data/branding.json`, else `Claw` | your agent's display name |
| `WORKSPACE_ACCENT` | `#4fe3d1` | theme accent color |
| `OPENCLAW_GATEWAY_WS` | from `openclaw.json` | gateway WebSocket URL |
| `OPENCLAW_DEFAULT_MODEL` | `agents.list[0].model` | model a fresh chat lands on |
| `INBOX_INTERNAL_DOMAIN` / `SLACK_DOMAIN` | — | inbox collector tuning |

The agent name is the one value that propagates everywhere: `setup.sh` writes it
to the gitignored `.data/branding.json`, and `scripts/sync-frontend.sh` bakes it
into the UI (replacing a `__AGENT_NAME__` token). `GET /api/config` exposes it at
runtime too.

## Layout

```
backend/            FastAPI app + the gateway bridge (the load-bearing new code)
  app.py            routes; serves the SPA; /api/config; /api/chat_stream
  bridge.py         OpenClaw gateway WS client → frontend SSE   ← the heart of it
  config.py         runtime config (reads ~/.openclaw/openclaw.json; branding)
  inbox/            native unified-feed collectors (gmail/slack/asana/obsidian)
  *.py              per-tab adapters (email, calendar, notes, documents, cron, …)
frontend-vendor/    the neutral SPA base, committed (sync's source of truth)
frontend/           build output: vendor + overrides, name-baked (gitignored)
frontend-overrides/ durable workspace customizations layered onto the SPA
scripts/            setup.sh · sync-frontend.sh · install-launchagent.sh
deploy/             LaunchAgent plist template
docs/               design specs/plans + SHIPPING.md (the productization checklist)
```

## Tests

```bash
. .venv/bin/activate && python -m pytest backend/tests -q
```

## License

[MIT](LICENSE) © The OpenClaw Workspace authors.
