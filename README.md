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

## What the tabs do

Each surface is wired to *your* live OpenClaw — its real accounts, its own vault,
its memory, its skills, its cron jobs. Account tabs hide themselves unless their
tooling is present and enabled, so a fresh install only shows what you can use.

| Surface | Wired to |
|---|---|
| **Chat** | The OpenClaw agent, with live tool-call cards and a model picker reading the real gateway catalog |
| **Inbox** | A scored, sorted triage feed (Gmail + Slack + Asana + meeting notes) with dismiss/review |
| **Email** | A real Gmail mailbox via `himalaya` — read, search, send, threaded reply, AI summarize/draft/reply in your learned writing style |
| **Calendar** | Real Google Calendar (read/create/update/delete), including natural-language quick-add ("lunch with Sam Tue 1pm") |
| **Notes & Documents** | Markdown-with-frontmatter files in the agent's own workspace vault — UI edits are agent-visible and vice-versa, with versioning + restore |
| **Memories** | The agent's curated long-term memory (`MEMORY.md`), editable, with auto-extraction of facts from web-search turns |
| **Skills** | The live skill catalog, each `SKILL.md` viewable, with enable/disable toggles |
| **Cron** | Real scheduled jobs — run-now, enable/disable, run history |
| **Web search** | SerpAPI-backed search that cites sources `[n]` inline in chat |

A gateway-monitor banner shows when the brain is restarting or down, and a stop
button aborts a running turn mid-stream.

The UI wears a Hermes-style skin: 4 theme colorways (Charcoal default), a
date-grouped conversation sidebar, and a read-only workspace file explorer
pane (adapted from [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui), MIT).

## Requirements

- A running **OpenClaw** install with its gateway up (default `ws://127.0.0.1:18789`).
  The workspace reads the gateway password and default model from
  `~/.openclaw/openclaw.json` — secrets never live in this repo.
- **Python 3.11+** (developed on 3.14).
- macOS or Linux. The "run on boot" helper is macOS-only (LaunchAgent); on Linux
  use a systemd unit running the same uvicorn command.

The Email, Calendar, and Inbox-collector tabs each need their own account wiring
and are optional — chat works with just OpenClaw.

## Connecting to your OpenClaw

- **Same host** (the workspace runs on the OpenClaw machine): nothing to
  configure — it reads `~/.openclaw/openclaw.json` for the gateway URL, password,
  and agent id.
- **Remote** OpenClaw: set `OPENCLAW_GATEWAY_WS=ws://host:18789` and
  `OPENCLAW_GATEWAY_PASSWORD=…` (the password is never written to disk by setup).
- If your agent isn't named `main`, it's read from `agents.list[0].id`; override
  with `OPENCLAW_AGENT_ID`.

Run `scripts/doctor.sh` any time to verify the connection (reachability, auth,
agent id, the gateway method contract).

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

## Publishing your own fork

If you're forking this to share your setup: `.data/` (your agent name) and
`frontend/` (the build) are gitignored, so your personal config stays out of git.
To publish a clean, single-commit history, run `scripts/prepare-public.sh` and push
the `public` branch it builds.

## License

[MIT](LICENSE) © The OpenClaw Workspace authors.
