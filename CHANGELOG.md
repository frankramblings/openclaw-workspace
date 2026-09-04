# Changelog

All notable changes to OpenClaw Workspace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased] — v2: installable on any OpenClaw

This milestone (branch `v2-installable`) makes the workspace a first-class
installable product that any OpenClaw user can run against their own gateway,
not just the original maintainer's setup.

### Pillar A: Agent control loop (real steering, 2026-09)

- Chat: real steering. While Gary is working on a claude-cli chat, Enter injects your message into the running turn (Claude Code style); Alt+Enter or "Queue instead" keeps today's queue. Needs the `claude-cli-steer` gateway patch (deploy/gateway-patches).
- Usage: hover or tap an assistant message for its tokens; the thread's context pill shows session totals; Settings → Usage charts 7 or 30 days from the gateway ledger (dollars only when every entry was priced).
- Changes review: every turn ends with a "Changes · n files · +a −r" card; expand for per-file diffs, a companion Changes tab, and a guarded Revert. Works for edits made by any tool, including shell heredocs. Settings → Changes controls the watched folders.

### Pillar B: Thread organization (OPEN shelf + Projects, 2026-09)

- Sidebar: an automatic OPEN shelf (threads you sent to in the last 48 h, running, queued, or active; cap 8) sits above PROJECTS and the date buckets, with live working/unseen pips, ⌥1..9 slot shortcuts, ⌥[ ] cycling, and a × on hover to leave the shelf. Sessions gain `opened` and `parent_id` (schema v2, migrates in place).
- Projects: threads file themselves into projects at title time via the local title model (precision over recall); a one-time backfill seeds the starter list and files the last 90 days by title. Corrections: row kebab → Move to, drag a row onto a project header, `New project…` inline. Header reads `Project › Thread`, forks show `↳ from <parent>`. Settings → Projects lists, renames, archives, deletes, and re-runs the backfill. Mobile drawer mirrors the sections and lands on the active project.
- Routes: `POST /api/session/{id}/close`, `POST /api/session/{id}/unfile`, `/api/projects` CRUD, `POST /api/projects/backfill`. Filing never counts as activity (`updated` untouched).

### Pillar D: Agent config backend (2026-09)

- MCP servers: `GET/POST /api/mcp/servers`, `DELETE /api/mcp/servers/{name}`, `POST /api/mcp/servers/{name}/enabled` now manage the gateway's own `mcp.servers` (openclaw.json) through `config.get` / `config.patch` with a base hash, an on-disk backup before every write, and a hot reload (no gateway restart). The mcporter-based routes, which read a different registry, are gone.
- Skill proposals: `GET /api/skill-proposals` (counts, pending first), `GET /api/skill-proposals/{id}`, `POST .../apply`, `POST .../reject`; apply backs up the current SKILL.md first, only pending proposals can be applied or rejected.
- Agent files: `GET/PUT /api/agent/files/{name}` for AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md with sha256 optimistic concurrency, a 512 KiB cap, a backup before every write, `GET .../backups` and `POST .../restore`.
- Gateway log tail: `GET /api/logs/tail?cursor&limit&max_bytes` (secret-scrubbed twice).
- Cross-cutting: backups and an audit log under `.data/agent-config` (0700/0600), `GET /api/agent-config/status` and `/audit`, the `agent_config` capability, and the `WORKSPACE_AGENT_CONFIG_WRITES=0` kill switch. No Settings UI yet; `scripts/livefire-agent-config.sh` exercises the routes.

### Pillar C1: @mention notes/documents, doc Q&A v1 (2026-09)

- Chat: type `@` at the start of the draft or right after a space to open a picker over your notes and documents (desktop and mobile composer); Enter, Tab, or a tap inserts `@[Title](note:id)` or `@[Title](doc:id)`. The mentioned note's or document's full text travels with the turn as a citation-tagged context block ("Cite them as [Title] when you use them"); documents get a `[Title › Heading]` anchor appended to every heading line (lines inside fenced code blocks are skipped). A sent mention shows as a chip in the bubble, and history shows your own typed text, not the injected block: the display strip now covers every wrap layer (terminal notes, draft mode, web search, the fork-context preamble), and chat search indexes and snippets the same stripped text, so a mentioned note body never surfaces as a chat result.
- Document Q&A v1: mentioning one or more notes/documents plus a question is the whole mechanism, no new endpoint and no vector index. A semantic v2 (chunked retrieval over notes and documents) is described in the design spec but not planned.
- `GET /api/palette` gained an optional `kinds=` filter (comma-separated subset of `session,note,document,email`; existing behavior unchanged when absent), the mention picker's only new backend surface (it always passes `kinds=note,document`).
- Fixed: mobile quick-capture notes saved with an empty body, the composer posted `body` while the backend only ever read `content`. The client now posts `content` and `backend/notes.py` also accepts `body` as a compatibility alias on `POST /api/notes` for any older caller.
- Fixed: an image sent together with a mention no longer disappears on reload, and a new thread opened with a mention is titled from your question instead of the injected block.
- Caps: 100 KB per mentioned item, 200 KB total per turn (the existing text-attachment caps, reused), 8 distinct mentions per turn.

### Pillar C2: In-document AI actions (2026-09)

- Document dock: Summarize / Rewrite / Continue / Ask buttons (a "✦" kebab on mobile, offering the three edit actions; Ask needs the desktop layout, where the composer and the dock are visible at once) run Gary against the open document over the existing draft-mode co-drafting loop: edits land in the vault file with the usual version snapshot, and the reply is a normal, steerable chat turn. Summarize and Ask are read-only prompts; Rewrite and Continue edit the file. A toolbar action while the current thread is busy, or while the composer holds an unsent draft, toasts instead of running; Rewrite with nothing selected toasts "Select some text in the document first."
- Composer: an "Editing: <title>" pill appears above the send row whenever a Library document is open in the dock, with an × to detach the next send only (it reattaches on the send after that). `active_doc_id`, and a selection hint for Rewrite, travel with any turn sent while attached, not just the toolbar buttons.
- Backend: a new optional `active_doc_selection` FormData field on `/api/chat_stream` (JSON `{from,to,text}`, 8 KB cap) lets `draft_mode.wrap_message` name the exact passage instead of the whole document; oversized or malformed input is silently ignored. No new routes.
- Unsaved edits are saved before any turn that carries the document, so Gary never reads a stale file and your pending autosave can no longer land on top of his edit mid-turn. If that save fails, the message is not sent: you get a toast and your text back.
- Conflict banner: the pending autosave is cancelled while the banner is up, and "Reload disk" writes the reloaded content back, so a document labelled "Saved" always matches what is on disk.
- Deploying this needs `scripts/sync-frontend.sh` for the frontend half and a service restart for the backend half.

### Phase 1 — Genericization (already merged to main)

- All maintainer-specific identifiers removed from source and committed assets.
- Agent name driven by `WORKSPACE_AGENT_NAME` env / `.data/branding.json`;
  default name changed to `Claw`.
- `scripts/setup.sh` wizard: interactive first-run setup with `--name`, `--yes`,
  `--skip-connect`, email/calendar sub-commands, and `--enable` for integrations.
- `scripts/sync-frontend.sh`: bakes the agent name and workspace overrides into
  `frontend/` from the vendored neutral base (`frontend-vendor/`).
- `frontend-vendor/` committed: the neutral SPA base (replaces the external
  Odysseus checkout dependency).
- `scripts/dev.sh`: one-command local bring-up (venv → deps → frontend → uvicorn).
- Email and Calendar wired as BYO-config optional tabs (IMAP/Gmail, CalDAV/Google).
- Inbox collectors made configurable via `.data/inbox.json` and env overrides.
- `backend/capabilities.py`: `/api/capabilities` endpoint drives UI tab gating.
- `scripts/prepare-public.sh`: produces a clean single-commit `public` branch
  for distribution.
- `CONTRIBUTING.md`, `LICENSE`, README overhauled for general audience.

### Phase 3 — Docker packaging (this branch)

- `Dockerfile` (multi-stage, Python 3.11-slim): installs deps, builds the
  frontend at image-build time with the default name `Claw`.
- `deploy/docker-entrypoint.sh`: re-bakes the frontend at container start if
  `WORKSPACE_AGENT_NAME` differs from the baked name; then execs uvicorn.
- `docker-compose.yml`: one-service compose; port bound to `127.0.0.1:8800` by
  default (not exposed on the LAN); `.data` volume for persistence; env-file
  passthrough; commented same-host `~/.openclaw` volume option.
- `.dockerignore`: excludes `.git`, `.venv`, `.data`, `frontend/` (rebuilt in
  image), `tmp`, `__pycache__`, `*.pyc`, `node_modules`, screenshots.

### Phase 4 slice — Optional auth gate

- `WORKSPACE_AUTH_TOKEN` env var: when unset (the default) the auth gate is a
  complete no-op — existing deploys are byte-for-byte unaffected. When set,
  every non-allowlisted request must present the token via Bearer header,
  `X-Workspace-Token` header, `?token=` query param, or `workspace_auth` cookie.
  Comparisons use `hmac.compare_digest` (constant-time).
- `?token=` auth sets an HttpOnly / SameSite=Lax `workspace_auth` cookie so
  subsequent browser requests work without repeating the query string.
- `/api/health` is always open (container health check allowlist).
- `/api/auth/features` now reports `auth_required: true` when a token is
  configured, so the SPA can reflect it.
- `/api/auth/status` username default changed from a hardcoded name to
  `WORKSPACE_USER` env var (else `"admin"`).
- `backend/config.py`: `auth_token()` and `workspace_user()` accessors added.
- `backend/auth_gate.py`: `AuthGateMiddleware`, a pure-ASGI middleware (not
  `BaseHTTPMiddleware`) so the chat SSE stream is never buffered; it is a complete
  no-op unless `WORKSPACE_AUTH_TOKEN` is set.
- 19 new tests in `backend/tests/test_auth_gate.py` (incl. an SSE-not-buffered guard).
