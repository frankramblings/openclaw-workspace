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

## Deferred: Deep Research (item 2)

Not glue — a real multi-round web-research engine with a bespoke streaming
protocol. Captured contract (from `js/research/{panel,jobs}.js`,
`js/researchSynapse.js`) for the next session:

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
