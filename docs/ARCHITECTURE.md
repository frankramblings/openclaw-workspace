# Architecture

OpenClaw Workspace is a thin web shell over an OpenClaw gateway. It deliberately
owns very little logic: the agent's brain, memory, tools, and skills all live in
OpenClaw. This document explains the moving parts.

```
 browser (SPA)  ──HTTP/SSE──▶  FastAPI app  ──WebSocket──▶  OpenClaw gateway
   frontend/                   backend/app.py               (the brain, :18789)
                               backend/bridge.py  ◀── the load-bearing piece
```

## The bridge (`backend/bridge.py`)

The one piece of genuinely new logic. The SPA speaks the HTTP+SSE dialect of a
typical chat backend (a `POST /api/chat_stream` that streams `data:` frames). The
gateway speaks its own JSON-over-WebSocket protocol and emits structured `chat`
and tool events. The bridge:

1. Opens a WebSocket to the gateway, authenticating with the password read from
   `~/.openclaw/openclaw.json` (never stored here).
2. Sends the user's turn on a **web-only session key** (`agent:main:web`) so the
   web UI never contends with other channels (e.g. Signal) that share the agent.
3. Translates gateway events back into the SSE frames the SPA expects — including
   tool-call start/output, which is what renders the live tool panels.

Because inference runs through the gateway's existing OAuth/subscription token,
there is **no per-token API billing** and no API key in this repo.

### Gateway method contract

The workspace requires the gateway to speak these methods (the read-only ones are
verified live by `scripts/doctor.sh`):

`chat.send`, `chat.abort`, `chat.history`; `sessions.create/delete/patch/json`;
`models.list`, `models.authStatus`; `cron.list/run/runs/update`;
`skills.status/update`.

If your OpenClaw is older and missing one, the doctor reports it (probing the
param-less read-only methods `models.list`, `skills.status`, `cron.list`).

## The app (`backend/app.py`)

A FastAPI application that:

- Serves the built SPA from `frontend/` (static files).
- Exposes `/api/chat_stream` (the bridge), `/api/config` (branding), `/api/health`,
  and a set of per-tab routers (`inbox`, `email`, `calendar`, `notes`, `documents`,
  `cron`, `memory`, `skills`, `research`, …). Each router is a thin adapter over an
  existing data source or an OpenClaw gateway method.

Config resolution lives in `backend/config.py`: env var → `~/.openclaw/openclaw.json`
→ default. Secrets only ever come from the gateway config or the environment.

## The frontend: vendor + overrides + bake

The UI is a vanilla-JS SPA. It is assembled, not hand-edited in place:

- **`frontend-vendor/`** — the committed neutral SPA base (the source of truth for
  the upstream files). Brand-neutral: it says "Odysseus" where a name is needed.
- **`frontend-overrides/`** — durable, workspace-specific customizations layered on
  top (full-file overrides + additive CSS/JS). User-visible brand text here uses
  the `__AGENT_NAME__` token. See that folder's README for the full inventory.
- **`scripts/sync-frontend.sh`** — the build: rsync the base → `frontend/`, copy the
  overrides over it, inject add-on `<script>`/`<link>` tags, **bake** `__AGENT_NAME__`
  and rebrand the base's "Odysseus" strings to the configured agent name.
- **`frontend/`** — the gitignored build output that actually gets served.

So one config value (the agent name) propagates to the whole UI at build time;
`GET /api/config` also exposes it for any runtime use.

## Branding flow (the headline feature)

```
scripts/setup.sh  ──writes──▶  .data/branding.json {"agent_name": "..."}
       │                              │
       │                              ├──▶ backend/config.agent_name()  ──▶ /api/config
       └──runs──▶ sync-frontend.sh  ──┘    (env WORKSPACE_AGENT_NAME overrides both)
                       │
                       └──bakes __AGENT_NAME__ + Odysseus→name──▶ frontend/
```

`.data/` is gitignored, so a user's chosen name never lands in the repo.

## Deployment

A single uvicorn process. Bind `127.0.0.1` and front it with a private network
(Tailscale `tailscale serve`) — there is **no app auth** (single-user by design).
`scripts/install-launchagent.sh` renders `deploy/*.plist.template` for macOS;
on Linux run the same uvicorn command from a systemd unit.

## What lives where

| Concern | Owner |
|---|---|
| Model access, inference billing | OpenClaw gateway |
| Memory, RAG, "dreaming" consolidation | OpenClaw |
| Tools, skills, MCP servers | OpenClaw |
| Chat transport + tool-panel rendering | the bridge |
| Tabs (inbox/email/calendar/docs/…) | thin adapters in `backend/` |
| Branding, UI assembly | `frontend-*` + `sync-frontend.sh` |
