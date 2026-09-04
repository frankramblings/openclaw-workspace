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

### `MIN_OPENCLAW` advisory

There is no hard version pin. `MIN_OPENCLAW` (when referenced in scripts) is
advisory only — the real floor is the method contract above. The doctor probes
those methods directly and reports any that are absent, so a too-old OpenClaw
surfaces a clear "method not found" message rather than a version-number comparison.
This means the workspace works with any OpenClaw that speaks the listed methods,
regardless of its release tag.

### Steering (2026-09)

A message sent while a claude-cli turn is running is injected into that turn:
`POST /api/chat/steer/{id}` → `chat.send` on the active session → the gateway's
steer queue → (patched) claude-cli reply handle `queueMessage` → Claude Code
stdin, delivered after the current tool result. The patch lives in
`deploy/gateway-patches/`; `GET /api/capabilities` reports `steer` only when the
running bundle carries it. Sessions on other runtimes keep the client-side queue.

## The app (`backend/app.py`)

A FastAPI application that:

- Serves the built SPA from `frontend/` (static files).
- Exposes `/api/chat_stream` (the bridge), `/api/config` (branding), `/api/health`,
  and a set of per-tab routers (`inbox`, `email`, `calendar`, `notes`, `documents`,
  `cron`, `memory`, `skills`, `research`, …). Each router is a thin adapter over an
  existing data source or an OpenClaw gateway method.

Config resolution lives in `backend/config.py`: env var → `~/.openclaw/openclaw.json`
→ default. Secrets only ever come from the gateway config or the environment.

### Change review (2026-09)

`backend/changes.py` observes the filesystem around every turn: per watched
root an index (path → mtime, size, sha256) plus a content-addressed cache of
the last seen text content. The turn recorder refreshes at turn start
(absorbing between-turn writes) and 1.5 s after turn end (this turn's change
set, flagged `shared` when another turn was active). Diffs are computed on
request from the cached blobs; revert restores the turn's before-state only if
the file has not moved on. Roots and prune list live in `.data/changes.json`
(Settings → Changes). It never uses git.

### Agent config (2026-09)

`backend/gateway_admin.py` wraps four gateway surfaces behind typed helpers,
all built on one new bridge seam, `bridge.gateway_call_result`, which returns
the whole `{ok, payload, error}` frame instead of raising on `ok: false` (the
seam every agent-config test fakes with `backend/tests/fake_gateway.py`
instead of opening a socket). `gateway_admin.http_error(exc)` maps the gateway's
message text to one HTTP envelope, `{"ok": false, "error": <code>, "detail":
<text>}`: unknown method to 501 `gateway_unsupported`, not found to 404
`not_found`, a non-pending proposal to 409 `not_pending`, a quarantined
proposal to 409 `quarantined`, a stale config hash to 409 `stale_config`, an
unsupported or unsafe file name to 400 `bad_name`, anything else the gateway
raised to 502 `gateway_error`, and a connection or timeout failure to 502
`gateway_unreachable`.

MCP servers are not a gateway method. `mcp.servers` is a path inside
`openclaw.json`, read with `config.get` and written with `config.patch`
(`backend/mcp_servers.py`), scoped to `{"mcp": {"servers": {<name>: ...}}}`
and carrying the `baseHash` from the preceding `config.get`. A stale hash
cannot occur on the 409 `exists` / 404 `not_found` path, since that path
returns before ever calling `config.patch`; it can only occur on a live
write, which re-reads once and retries once, each retry taking its own
pre-write backup (both entries survive, pruned to the newest 20 like any
backup). A patch under `mcp.*` hot-reloads the gateway's MCP runtimes; it
does not restart it. The old `/api/mcp/servers` routes in
`backend/settings_status.py` shelled out to `mcporter` against
`~/.openclaw/workspace/config/mcporter.json`, a registry the gateway never
reads; they are gone.

Every write route follows the same pipeline: kill switch
(`agent_config_store.writes_enabled()`, env `WORKSPACE_AGENT_CONFIG_WRITES`,
default on) then validate the request shape before any gateway call, then
read current state from the gateway, then back up that state to disk, then
make the gateway write, then append one audit line. `backend/agent_config_store.py`
keeps both under `.data/agent-config`: `backups/<kind>/<key-slug>/<id>.txt`
+`.json` (content plus `{id, ts, size, sha256, kind, key, meta}`, pruned to
the newest 20 per key) and one `audit.jsonl` (`{ts, action, target, ok,
...fields}`). The audit rule is narrower than "any state read": a route
audits once it has committed to a write, meaning a backup was taken or a
gateway write was attempted, plus the MCP `config.patch` routes' 409
`exists` / 404 `not_found` paths, which audit on the strength of the
`config.get` that already ran even though they take no backup and never
call `config.patch`. A route that reads state and then declines to write
(skill_proposals.py's 409 `not_pending`, agent_files.py's 409 `stale` and
its `unchanged: true` no-op) writes no audit line, since it never committed
to a write. Every directory level under `.data/agent-config` is created
0700 and every file 0600; `key_slug()` folds `/` to `__` and anything outside
`[A-Za-z0-9._-]` to `_`, and maps a slug of `.` or `..` to `_` so a key never
resolves to an existing ancestor directory. `GET /api/agent-config/status`
and `/audit` expose the switch, the default agent id, and the recent log; the
`agent_config` capability (`backend/capabilities.py`) reports `writes`.

Agent files (`backend/agent_files.py`) route every name through the
allowlist (`AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md,
HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md`) before any gateway call; a catch-all
`/api/agent/files/{name:path}` route, registered last, answers 400 `bad_name`
for any name containing a slash on GET/PUT/POST/DELETE so a traversal-shaped
name never reaches `agents.files.*`. `agents.files.set` is a full replace
with no previous version kept gateway-side, so this backend snapshots the
current content first and offers it back through `.../backups` and
`.../restore`; a `base_sha256` mismatch on `PUT` answers 409 `stale` unless
`force` is set.

UI: none yet (planned). `scripts/livefire-agent-config.sh` exercises every
route against a running instance.

Two consequences worth stating plainly, not defects: (a) `POST /api/mcp/servers`
with a `command` field makes the gateway spawn that process on the agent's
next MCP load; an authenticated backend session could already run an
arbitrary process via the existing terminal route, so this does not raise
the privilege ceiling, but a future Settings UI should confirm stdio adds
explicitly rather than let one slip through unnoticed. (b) The pre-write
backup for an MCP write reads the config file straight off local disk at the
path `config.get`'s snapshot reports (`backend/mcp_servers.py`), which means
the backend process must share a filesystem with the gateway. On a split
deployment (backend and gateway on different hosts) every MCP write answers
500 `backup_failed`; MCP reads are unaffected, since they go through
`config.get` over the gateway connection and never touch the local disk.

### @mentions (2026-09)

`backend/mentions.py` parses `@[Title](note:id)` / `@[Title](doc:id)` tokens
out of the sent chat message, resolves each against the existing vault
stores (notes via `notes._path` + `vault_store.load_entry`, documents via
`documents._load`), and prepends a citation-tagged context block using the
same message-text-prefix convention every other injection in this app uses.
It is the closest sibling to `websearch.py`'s `context_block`/
`strip_context_block`, but uses its own marker
(`"\n\n---\n\nUser message (mentions resolved above): "`), not websearch's:
in production the two wraps nest (`prepend_mentions` runs first, at the
route boundary; `chat_turn.py`'s websearch wrap runs later, around the
already-mentions-wrapped text), and a shared marker would let one strip
swallow the other's block. `mentions.strip_context_block` only matches its
own intro text at the two positions it can structurally occupy (the very
start of the string, or immediately after websearch's own prefix and
marker), never at an arbitrary position, so a message that merely quotes
the wrapper text is never mistaken for a real wrap. `GET
/api/history/{id}` runs the display-side strip chain outer-to-inner,
matching `chat_turn.py`'s real nesting order: the terminal-control note
first (`terminals.strip_capability_note`), then websearch, then mentions.

Wired into `chat_stream` right after `_prepend_text_attachments` and before
`_scrub_secrets`; the steer route (`POST /api/chat/steer/{id}`) does not
expand mentions. The picker's data comes from `GET
/api/palette?kinds=note,document` (`backend/palette_routes.py`'s optional
`kinds` filter, added for this feature; the palette gained no new source
and no caching layer). Document Q&A v1 is not a separate mechanism: it is
a mention plus a question, grounded on the whole body of each mentioned
note or document (capped, like every text injection here, at 100 KB per
item and 200 KB per turn) with `[Title › Heading]` anchors prefixed onto
every heading line of a mentioned document's body so Gary can cite a
specific section. A resolve failure (missing id, unreadable vault file)
never breaks the turn: the item renders as `── Note: Title (not found)
──` in the context block instead.

The frontend picker (`frontend-overrides/js/redesign/mention-core.js` for
the pure token/insertion helpers, `frontend-overrides/js/redesign/live/
mention-picker.js` for the direct-DOM widget) is painted with
`insertAdjacentHTML` above the composer and updated on `input` events
outside the render loop, the same pattern as the ghost-suggestion overlay,
because the mobile composer never re-renders on keystroke. It self-boots
on import (a `DOMContentLoaded` guard, like `live/jobs.js`) and serves both
the desktop `draft` and mobile `mdraft` composers from one instance.
`app.js`'s keydown handler runs the picker's `handleMentionKeydown` after
the slash menu and before the ghost-suggestion/plain-Enter fallthrough, so
Enter/Tab/Arrow keys pick a mention instead of sending or completing a
slash command while a mention token is open. `.m-composer` carries
`position: relative` and `.mention-menu` a `z-index: var(--z-dropdown)` so
the menu paints above the mobile composer's own layout; a click outside
the menu (and outside the composer it opened on) closes it on both
surfaces, and a failed `/api/palette` fetch renders "Could not search
notes" rather than the empty-results copy.

Riding along: mobile quick-capture posted `body` on `POST /api/notes` while
the route only ever read `content`, so a capture always saved with an
empty body. `mobile-app.js`'s `sendCapture` now posts `content`, and
`create_note` accepts `body` as a compatibility alias when `content` is
absent or empty (content always wins when both are present).

Deploying either the backend or frontend half of this feature to the
served app still requires `scripts/sync-frontend.sh`: `frontend-overrides/`
edits have no effect until the build step bakes them into the gitignored
`frontend/`.

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

## v2 modules (installable-anywhere)

The v2 branch added these backend modules to make the workspace installable on any
OpenClaw without editing source. One line each for contributor navigation:

- **`config.agent_id()` / `config.load_connection()`** — derive the agent id and
  gateway connection details from env vars → `.data/connection.json` →
  `~/.openclaw/openclaw.json`, in that precedence order.
- **`doctor.py` + `GET /api/doctor` + `scripts/doctor.sh`** — read-only preflight:
  gateway reachability, auth, agent id resolution, and the method-contract probe.
- **`capabilities.py` + `GET /api/capabilities`** — data-driven tab gating; each tab
  reports itself as available only when its tooling is present and configured.
- **`email_config.py`** — renders a himalaya account block and writes the
  mode-600 password file; invoked by `scripts/setup.sh --add-email`.
- **`calendar.py`** (provider-selecting router) + **`calendar_config.py`** (provider
  selector, defaulting to google) + **`calendar_caldav.py`** (CalDAV client) +
  **`ical.py`** (dependency-free VEVENT (de)serializer); `calendar_google.py` was
  refactored to plain provider functions. All wired via `setup.sh --add-calendar`.
- **`inbox/settings.py`** — config-driven collector selection via `.data/inbox.json`
  (default: all collectors on; precedence env > inbox.json > built-in default).
- **`auth_gate.py`** — optional pure-ASGI token gate (`WORKSPACE_AUTH_TOKEN` env
  var, off by default, SSE-safe so streaming turns are not buffered by middleware).

## What lives where

| Concern | Owner |
|---|---|
| Model access, inference billing | OpenClaw gateway |
| Memory, RAG, "dreaming" consolidation | OpenClaw |
| Tools, skills, MCP servers | OpenClaw |
| Chat transport + tool-panel rendering | the bridge |
| Tabs (inbox/email/calendar/docs/…) | thin adapters in `backend/` |
| Branding, UI assembly | `frontend-*` + `sync-frontend.sh` |
| Per-integration config (accounts, secrets) | gitignored `.data/*.json`; secrets in mode-600 files or env — never in JSON |
