# Wiring up (and hiding) Odysseus's unwired tabs — 2026-06-05

The reused Odysseus SPA renders many surfaces that had no backend here: GETs hit
the `_unimplemented_api` catch-all (`[]`) and writes 404'd. `/api/auth/status`
also reports every `can_use_*` privilege true, so the UI advertised them as
working. This change wires the high-value ones to real backends and hides the
rest.

## Done

### Notes + Documents → vault adapter
Store entries as markdown files in the agent vault (`~/.openclaw/workspace`), so
the web UI and the agent share one store (the vault is `agents.defaults.workspace`).

- `backend/vault_store.py` — dependency-free frontmatter codec (`key: <json>` per
  line; body = content). No PyYAML (launchd service runs system python).
- `backend/notes.py` — `~/.openclaw/workspace/Notes/<id>.md`. Full note JSON
  round-trips via frontmatter; body = note content. Endpoints: list (`{notes}`),
  create, update, delete, reorder, fire-reminder (stub).
- `backend/documents.py` — `~/.openclaw/workspace/Documents/<id>.md` + version
  snapshots in `.versions/<id>/v<n>.md`. Endpoints: create, get, save (bumps
  version), delete, archive, list-by-session, library, versions, version/{n},
  restore/{n}. PDF import/export = 501 stubs.
- `backend/uploads.py` — `/api/upload` (field `files` → `{files:[{id}]}`) +
  `/api/upload/{id}` serving from `~/.openclaw/workspace/.attachments/`.
- Registered in `app.py` before the catch-all. The SPA's existing editors
  (note textarea, doc editor pane) now persist — no new editor needed.

### Hidden dead chrome
`frontend-overrides/workspace.css` hides `#rail-*` + `#tool-*-btn` for **Tasks**
(use Cron), **Gallery**, **Cookbook**, **Compare**, plus `.ai-tts-button` (TTS).
STT/voice disabled by commenting out `voiceRecorder.js` in `index.html`.

### Deep Research → the agent IS the engine (built 2026-06-05)

`backend/research.py`. No separate research stack: codex already has web
search/fetch tools, so a job = 1–3 bridge turns on a dedicated gateway session
(`agent:main:web-research-<id>`) — each round prompts "search the web, reply
with a cumulative findings JSON block"; the report turn runs on a FRESH
`…-write` session with the findings + round notes inlined. Tool cards from the
turns drive the live phases (search-ish → `searching`, web-fetch-ish →
`reading` + source counter, agent file-housekeeping ignored); counters are
cumulative as the synapse requires. Reports persist to the vault
(`Research/<id>.md`, same frontmatter codec as Notes/Documents) so the agent
can read its own research.

Two failure modes found by live smoke-testing shaped the engine:
- **Late delivery**: the agent often replies via its `message` tool, whose text
  lands in the transcript seconds AFTER the run's lifecycle end — the live
  stream only carries a one-line stub. `_turn()` therefore polls
  `chat.history` briefly when the streamed text fails its `expect` predicate.
- **Token-cap thread reset**: one research round pushed the session to 80.5k
  tokens (cap 70k) and the gateway silently started a fresh thread, orphaning
  a same-session report turn (it hung > 15 min). Hence the self-contained
  report prompt on a fresh session.

All captured endpoints implemented, plus two found during the build:
`GET /api/research/report/{id}` (standalone dark-mode HTML page; renders via
the SPA's own `markdown.js`, `<pre>` fallback) and `GET /api/model-endpoints`
(gateway catalog → research panel's endpoint picker). `spinoff` mints a real
chat session and seeds the report into its gateway thread (awaited) before
returning the session id. `max_rounds` is honored 1–3 (gap-fill prompts on
rounds ≥2); `search_provider` is accepted but moot — the agent picks its own
tools. Pure parts unit-tested in `backend/tests/test_research.py`.

Also flipped `can_generate_images` → `False` in `/api/auth/status` (no image
backend; hides `#tool-image-btn` — Gallery chrome was already CSS-hidden).
Tasks/Gallery/Cookbook/Compare have **no** per-feature `can_use_*` flags in the
SPA, so the CSS overrides above remain the mechanism for those.

## Captured contract (now implemented)

From `js/research/{panel,jobs}.js`, `js/researchSynapse.js`:

- `POST /api/research/start {query, ...settings}` → `{session_id}`
- `GET /api/research/stream/{id}` (SSE): JSON-per-line progress events with
  `phase` ∈ probing|planning|searching|reading|analyzing|writing|done, plus
  `round`, `queries`, `title`, `total_sources`, `total_findings`, `model`,
  `started_at`, and a terminal `{final:true, status}`. Drives the "synapse"
  SVG (setPhase/setRound/setSourceCount), so round/source counters must be
  cumulative and phases in order.
- `GET /api/research/status/{id}` (poll fallback, same progress shape)
- `POST /api/research/result-peek/{id}` → `{result: <markdown>, sources:[{title,url}], raw_findings:[{title,url,summary}], category}`
- `GET /api/research/library`, `/active`, `POST /cancel/{id}`, `DELETE /{id}`,
  `POST /{id}/archive`, `POST /spinoff/{id}`, `GET /model-endpoints`

Build path: a backend loop using the enabled web tools (brave/duckduckgo/serpapi
search + web_fetch) for search→read, codex (via the bridge/gateway) for
query-planning + synthesis, emitting the phase events above. Estimate: a working
single-/few-round version is a focused build; full multi-round is larger.
