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

## Optional integrations

Tabs that need your own accounts are off until you configure them; until then
they're hidden (the backend reports them via `/api/capabilities`).

### Email

```bash
scripts/setup.sh --add-email          # interactive (Gmail app-password or IMAP)
```

For Gmail, create an **App Password** (Google Account → Security → App passwords)
and paste it when prompted — it's stored in a mode-600 file next to your himalaya
config, never in this repo. For other providers choose `imap` and enter your
IMAP/SMTP hosts. Restart the workspace afterward to pick up the account.

### Calendar

```bash
scripts/setup.sh --add-calendar       # choose 'caldav' (universal) or 'google'
```

**CalDAV** works with Google, iCloud, Fastmail, Nextcloud, etc. — give your
calendar home URL (e.g. `https://caldav.fastmail.com/dav/calendars/user/you/`),
username, and an app password (stored mode-600, never in the repo). **Google**
(the default) uses OAuth tokens at `GOOGLE_OAUTH_KEYS` / `GOOGLE_CAL_TOKENS`.
Restart the workspace afterward.

### Inbox

```bash
scripts/setup.sh --enable inbox       # turn the unified Inbox tab on
```

The Inbox merges several collectors (Gmail, Slack, Asana, Obsidian meeting
notes, and stale workspace documents). Which ones run is config-driven via an
optional `.data/inbox.json` (gitignored):

```json
{ "collectors": {
    "gmail":    { "enabled": true, "internal_domain": "example.com" },
    "slack":    { "enabled": true, "domain": "example.slack.com" },
    "asana":    { "enabled": true, "project_gid": "", "pat_path": "~/.openclaw/workspace/secrets/asana.env" },
    "obsidian": { "enabled": true, "vault": "~/.openclaw/workspace/Meetings", "window_days": 120, "owner_name": "" }
} }
```

**Default (no file): all collectors are on**, so existing installs are
unchanged — disable the ones you don't use by setting `"enabled": false`. A
collector that isn't configured simply doesn't run (e.g. Asana stays off until
it has both a `project_gid` and a PAT file). Each setting can also be overridden
by its env var (which wins over `inbox.json`); see `.env.example`. Secrets
(like the Asana PAT) live in their own files referenced by path — never in
`inbox.json`.

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

## Running with Docker

```bash
# 1. Copy and edit the config template
cp .env.example .env
# Edit .env: set OPENCLAW_GATEWAY_WS, OPENCLAW_GATEWAY_PASSWORD, etc.

# 2. Build and start
docker compose up --build
# → http://127.0.0.1:8800
```

The port is bound to **`127.0.0.1:8800`** by default — it is NOT exposed on the
LAN. This matches the bare-metal security model: reach it remotely over Tailscale
or an SSH tunnel.

### Customizing the agent name

Set `WORKSPACE_AGENT_NAME` in `.env`. The entrypoint detects a name change and
re-bakes the frontend before starting uvicorn, so the new name shows in the UI:

```
WORKSPACE_AGENT_NAME=Gary
```

### Persisting state

`./.data` is mounted into `/app/.data` as a Docker volume so branding, session
metadata, and connection config survive container rebuilds. Back this directory
up if it matters.

### Same-host OpenClaw mount

If OpenClaw runs on the same machine you can mount its config directory so the
workspace reads the gateway password and agent config automatically (no env vars
needed). Uncomment this line in `docker-compose.yml`:

```yaml
      - ~/.openclaw:/root/.openclaw:ro
```

### Exposing beyond localhost

To expose beyond `127.0.0.1` (e.g. on a LAN or via a reverse proxy) you MUST
first set `WORKSPACE_AUTH_TOKEN` — see the Security model section below.

## Security model

By default there is **no app-level authentication** — the network is the
boundary. The defaults are safe:

- Port is bound to **`127.0.0.1`** (bare-metal) / `127.0.0.1:8800` (Docker),
  so it is not reachable from the LAN without deliberate change.
- Recommended remote-access path: Tailscale Serve in front of `127.0.0.1:8800`
  (`tailscale serve --bg --https=8443 127.0.0.1:8800`).
- **Do not** bind `0.0.0.0` on an untrusted LAN. The agent has shell access, so
  an open port is effectively root on your box.

### Optional token auth (`WORKSPACE_AUTH_TOKEN`)

Set this env var to require a secret token on every request — **required** if
you expose the port beyond localhost:

```
WORKSPACE_AUTH_TOKEN=your-long-random-secret
```

When set, every request must include the token via one of:
- `Authorization: Bearer <token>` header
- `X-Workspace-Token: <token>` header
- `?token=<token>` query parameter
- `workspace_auth` cookie (set automatically after a successful `?token=` request)

The `/api/health` endpoint is always open (used by Docker health checks).

**Browser convenience:** visit `http://host:8800/?token=<token>` once; the server
sets an HttpOnly cookie so subsequent page loads work without repeating the token.

When unset (the default) the auth gate is a complete no-op — existing deploys are
unaffected.

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
