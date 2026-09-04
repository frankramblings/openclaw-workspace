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
/api/history/{id}` and the chat search indexer
(`chat_search._extract_chunks`) both call one helper,
`history_display.history_display_text`, which runs the display-side strip
chain outer-to-inner in `chat_turn.py`'s real nesting order: the terminal
notes first (`terminals.strip_capability_note`), then the draft-mode
wrapper (`draft_mode.strip_wrapper`), then websearch, then mentions, whose
third anchor case handles a block sitting after a fork-context preamble's
`Frank: ` lead. Sharing the helper is what keeps the displayed text and the
indexed text from drifting apart.

Wired into `chat_stream` right after `_prepend_text_attachments` and before
`_scrub_secrets`; the steer route (`POST /api/chat/steer/{id}`) does not
expand mentions. The picker's data comes from `GET
/api/palette?kinds=note,document` (`backend/palette_routes.py`'s optional
`kinds` filter, added for this feature; the palette gained no new source
and no caching layer). Document Q&A v1 is not a separate mechanism: it is
a mention plus a question, grounded on the whole body of each mentioned
note or document (capped, like every text injection here, at 100 KB per
item and 200 KB per turn) with a `[Title › Heading]` anchor appended to
every heading line of a mentioned document's body (lines inside fenced code
blocks are skipped) so Gary can cite a specific section. A resolve failure (missing id, unreadable vault file)
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
the menu paints above the mobile composer's own layout; on both surfaces a
click closes the picker unless it lands inside `.mention-menu` itself or on
the exact textarea the token opened on, so a click anywhere else, including
another control inside the same composer, closes it. A failed
`/api/palette` fetch renders "Could not search notes" rather than the
empty-results copy. A commit writes the composer state field the textarea
binds through `data-model` (the mobile textarea is focus-keyed `mdraft` but
model-bound to `draft`, which is what send reads), and a picker whose menu
was detached by a background render either adopts the live token again or
swallows one Enter, so a stale picker never becomes a send. In a sent
message the token renders as a `.mention-chip` on both surfaces
(`mention-core.renderWithMentionChips`), and one CSS rule serves
`.slash-menu` and `.mention-menu` so the two composer menus line up.

Riding along: mobile quick-capture posted `body` on `POST /api/notes` while
the route only ever read `content`, so a capture always saved with an
empty body. `mobile-app.js`'s `sendCapture` now posts `content`, and
`create_note` accepts `body` as a compatibility alias when `content` is
absent or empty (content always wins when both are present).

Deploying the frontend half of this feature to the served app requires
`scripts/sync-frontend.sh`: `frontend-overrides/` edits have no effect
until the build step bakes them into the gitignored `frontend/`. The
backend half needs a service restart instead; sync-frontend only bakes the
overlay.

### In-document AI (2026-09)

`backend/draft_mode.py` was already a complete co-drafting loop
(`pre_turn` snapshots the doc and returns it, `wrap_message` prefixes the
turn with a note naming the vault file, `post_turn_payload` re-reads the
file after the turn and returns a `doc_update` payload when it changed) wired
into `/api/chat_stream` via `active_doc_id`, but only the legacy classic UI
ever sent that field or handled the frame. Pillar C2 adds the frontend wiring
and one backend field: an optional `active_doc_selection` FormData field
(JSON `{from,to,text}`, `draft_mode.SELECTION_MAX_BYTES` = 8 KB, parsed by
`draft_mode.parse_selection`) so `wrap_message` can name the exact selected
passage instead of the whole document for Rewrite. A selection-wrapped
message ends in a second literal tail (`_WRAP_SELECTION_TAIL`, not the plain
`_WRAP_TAIL`), so `draft_mode.strip_wrapper`, and therefore
`history_display.history_display_text`, used by both `/api/history` and chat
search, still strips it back to exactly what the user typed.
`strip_wrapper` decides which of the two note shapes it is looking at before
it partitions (the selection variant continues "leave the file alone. The
user has selected this passage"), because either tail literal can also occur
inside the selection or inside the user's own text, and trying both in turn
cut the message at the wrong place. No new routes and no new turn mechanism.

On the frontend, `document-editor.js` gained pure/impure helpers:
`activeLibraryDocId()` (the open doc's id, only for a Library document, never
a workspace file), `getSelection()` (Toast UI's `getSelectedText()` plus,
in markdown mode, the nested `[[line,ch],[line,ch]]` pair from
`mdEditor.editor.getSelection()`, converted to flat character offsets by
`selectionFromMarkdownEditor`), `shouldAcceptDocUpdate()`/
`applyExternalUpdate()` (a clean buffer reloads silently with the caret
preserved and an "Updated" chip, a dirty buffer stashes the incoming content
and shows the existing conflict banner; a frame whose `content` isn't a
string is rejected outright rather than blanking the document), and
`consumeAttachDetach()` for the per-turn detach flag, and
`flushBeforeSend()`/`flushOk()` (below). `live/chat.js`'s
`fireSend`/`keepaliveSend` attach `active_doc_id` and, when there is a live
selection, `active_doc_selection` to every turn sent while a Library document
is open and not detached (`trimSelectionText`/`selectionField` trim an
oversized selection to stay under the server's 8 KB cap rather than let it be
dropped outright), and handle an incoming `type: "doc_update"` SSE frame by
calling `applyExternalUpdate`. `surfaces.js` and `mobile-surfaces.js` render
an "Editing: <title>" pill above the composer with an × that detaches only
the next send; both call the one shared `docPillHtml`/`libraryDocIdFor` in
`redesign/doc-pill.js`, so what the pill shows and what a send attaches can
never drift apart.

**The pre-send flush.** A doc-bound turn makes the backend read the vault
file from disk, and `pre_turn`'s snapshot is the user's only undo, so the
buffer has to be on disk before the turn opens. `flushBeforeSend()` cancels
the armed 2.5s autosave and awaits the pending save through the same
`actions.saveDoc()` path autosave and the Save button use; `chat.js` awaits
it in `submitFromComposer` and `dispatchSend` (and `runAiAction` awaits it
before it triggers a send) whenever a Library doc will be attached. A clean
buffer resolves immediately and costs nothing. A failed or conflicted save
aborts the send outright, toasts, and hands the text back to the composer:
attaching anyway would point the turn at a file that does not hold what the
user is looking at. `keepaliveSend` is the one exception, deliberately: it
runs from a pagehide teardown where nothing can be awaited, so it stays a
single synchronous fire-and-forget POST.

**Conflict rules.** While the conflict banner is up, the armed autosave is
cancelled (both in `applyExternalUpdate`'s dirty branch and in
`handleExternalChange`'s), so it can no longer fire underneath the banner and
PUT the user's buffer over the edit the banner is asking about. "Reload disk"
(`acceptIncoming`) re-saves the accepted content for a Library doc, because
`PUT /api/document/{id}` has no version precondition and an earlier autosave
may already have overwritten it, so a buffer labelled "Saved" is only honest
once it has been written back. Workspace files skip that re-save: their
incoming content came off disk with a matching mtime. An `if_version`
precondition on the document PUT, mirroring the workspace file's
`if_mtime_ns`, is the proper fix and is still a follow-up.

`redesign/doc-ai-prompts.js` is a DOM-free module of pure prompt builders
(`buildSummarizePrompt`, `buildContinuePrompt`, `buildRewritePrompt`,
`ASK_PLACEHOLDER`) used by a dock-header toolbar in `document-editor.js`:
four buttons on desktop (`aiBar`), a "✦" kebab menu on mobile (`aiKebabBtn`/
`aiMenu`), routed through `resolveAiAction`/`dispatchAiAction`/`runAiAction`/
`askAction`. Rewrite with nothing selected, running a document action while
the current thread is busy (`turnBusyHere`), and running one with an unsent
draft in the composer all refuse with a toast instead of sending; Ask only
sets the composer placeholder and force-attaches the pill, it never sends by
itself.

**Mobile.** On the mobile shell the dock is `100vw` and sits over the
composer, so the kebab offers the three one-shot edit actions only
(`MOBILE_AI_ACTIONS`): Ask would focus a textarea the user cannot see, and
its placeholder is cleared the moment the dock closes. Ask stays on the
desktop toolbar, and a typed message can only carry `active_doc_id` on the
desktop layout, where the composer and the dock are visible at once. A
minimized-dock state that would make Ask and typed doc-bound messages work on
mobile is a follow-up, not built here.

Deploying this feature needs the same two steps as the mentions feature
above: `scripts/sync-frontend.sh` for the frontend half, a service restart
for the backend half.

### URL clip (2026-09)

`backend/clip.py`'s `POST /api/clip` is the first route in this codebase
that fetches an arbitrary user-supplied URL, so the SSRF guard it
introduces (`clip_guard.py`) was built from scratch, not adapted from an
existing pattern (`backend/websearch.py` only ever calls SerpAPI's own
JSON API). The pipeline is three modules with no shared state:
`clip_guard.py` (pure SSRF policy, no I/O) validates a URL's scheme,
credentials, and hostname shape, then `resolve_and_check` requires every
DNS-resolved address to clear the same deny-list (loopback, RFC1918,
link-local, multicast, reserved, unspecified, RFC 6598 shared/CGNAT
space, and their IPv6 equivalents, including explicitly pinned 6to4,
Teredo, NAT64 and `::/8` prefixes whose embedded IPv4 is checked too,
plus `localhost` and any `.local`/`.internal`/`.lan`/`.localhost` host); `clip_fetch.py` runs a manual,
guard-revalidated redirect loop (`httpx.AsyncClient(follow_redirects=False)`)
so every hop, not just the first URL, goes back through the same guard,
capped at 3 redirects, under one wall-clock budget
(`WORKSPACE_CLIP_TIMEOUT_S`, default 15 s) that covers both connecting
and the streamed body read, checked before each hop and again on every
chunk; the body is capped at `WORKSPACE_CLIP_MAX_BYTES` (default 5 MB),
enforced mid-stream rather than trusting Content-Length. Both caps are
clamped into a sane range (1 to 300 s, 1 KB to 256 MB) so a stray `inf`,
`nan`, zero or negative env value cannot disable them. The request asks
for an identity (unencoded) body and any response that still declares a
`Content-Encoding` is refused before the body is read at all: httpx would
otherwise decompress each socket read before the size cap could see it,
so a few hundred bytes of brotli could allocate gigabytes. The response
Content-Type must be one of `text/html`, `application/xhtml+xml`,
`text/plain`, `text/markdown`, `application/pdf`. `clip_extract.py` turns
the fetched body into markdown: `trafilatura` when installed (falling
back to a tag-stripped-text extractor if it is missing, raises, or
returns nothing usable), a pass-through for `text/plain`/`text/markdown`,
and the existing `attachments.py` PDF-text helper for `application/pdf`.
Extraction runs in a worker thread under its own 20 s bound; on expiry the
request returns `extract_failed` (the thread itself runs to completion,
since a `to_thread` task cannot be cancelled from outside).

Honest limitation, not fully closed: the guard is check-then-connect
(`resolve_and_check` validates the resolved addresses, then httpx
resolves the same hostname again when it actually connects), so a narrow
DNS-rebinding window remains between those two resolutions. The per-hop
re-check plus the deny-list closes the practical case (a redirect or a
plain lookup landing on a static internal host); it does not close a
live, precisely-timed TTL-0 rebinding attack. Closing that fully needs
connecting directly to the already-checked IP with the original Host
header preserved (an httpx transport-level change), accepted as a
residual v1 risk.

`POST /api/clip` takes JSON `{url, title?, session_id?}` and returns
`{ok: true, document: <doc>, mention: "@[Title](doc:<id>)", meta:
{source_url, final_url, site_name, byline, fetched_at, content_type,
bytes, extractor, redirects}}` on success. A failure is `{ok: false,
error, detail}` with `error` one of `bad_url` (400, an unparseable JSON
body, an unparseable URL, a bad scheme, embedded credentials, or a
control character, an out-of-range or non-numeric port, or an
unparseable redirect target), `bad_request` (400, a JSON body that parses but is
not an object, or a non-string `title`/`session_id`), `blocked_host`
(400, the SSRF guard), `fetch_failed` (502, a
connection error, a non-200 status, an unresolvable host, or a response
body that arrived compressed),
`too_large` (413), `unsupported_type` (415), `extract_failed` (422,
nothing readable came out, or extraction ran past its own time bound), or `write_failed` (500, the document write
or version snapshot itself failed). Re-clipping a URL already in the
Library (matched by an exact, `clip_guard`-normalized `source_url`)
snapshots the existing document's body into version history, then
updates it in place rather than creating a duplicate; a brand-new clip
creates a `documents.py` entry with `source_url`, `source_final_url`,
`source_site`, `source_byline`, and `clipped_at` alongside the usual
fields.

Three entry points share this one route: a Library "Clip URL" button
that prompts for a URL and opens the resulting document; a composer
"Clip" chip (`clip-core.js`) that appears whenever the trimmed draft is
exactly one http(s) URL; and a `?action=clip&q=<url>[&mention=1]` deep
link (`deeplink.js`) for an iOS Shortcut, which optionally drops the
mention token into a fresh chat's composer.

Deploying this needs `scripts/sync-frontend.sh` for the frontend half,
and for the backend half both a service restart and `pip install -r
backend/requirements.txt` to pick up `trafilatura` (an optional,
lazily-imported dependency: without it, clip runs on the tag-stripped
fallback extractor instead of failing).

### Tenant portability (2026-09)

Nothing tenant-specific lives in code. `config.agent_name()`, `user_name()`,
`local_host()` read env, then `.data/branding.json`. Change-tracker roots
default from HOME and the checkout (`changes.default_roots()`); project seeds
come from `.data/projects_seed.json`; a tenant with no projects gets one
discovery pass (`project_discovery.py`) that writes proposals for Settings →
Projects to accept. `scripts/publish-scan.sh` is the shared gate (also a
pytest) and `scripts/deploy.sh` ships both tenants.

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
