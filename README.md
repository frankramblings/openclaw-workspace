# OpenClaw Workspace

A single-context web workspace over [OpenClaw](https://github.com/openclaw/openclaw) —
chat, live tool-call panels, unified inbox triage, and a doc workspace, all driven by
OpenClaw's gateway brain at **subscription pricing** (no API key).

It reuses three things that already work, and adds only the glue:

- **Brain** — OpenClaw's gateway (codex agent on a ChatGPT-subscription OAuth token).
- **Chassis** — the [Odysseus](/) SPA + FastAPI `/api` shell (its frontend is backend-agnostic).
- **Inbox data** — OpenClaw's existing triage-dashboard unified feed.

The new code is the **bridge** (`backend/bridge.py`): it speaks OpenClaw's gateway
WebSocket protocol and re-emits events as the SSE the Odysseus frontend expects — which
is what keeps us on subscription pricing *and* renders tool calls live.

See `docs/superpowers/specs/2026-06-03-openclaw-workspace-ui-design.md` for the full design.

## Status: v1 scaffold

- ✅ Chat tab → bridge → OpenClaw brain, with live tool-call panels (needs a live smoke-test).
- ✅ Inbox feed proxied at `/api/items` (frontend wiring is a v2 follow-up).
- ⚠️ Other tabs inert until their `/api` is ported (v2).

## Run

Prereqs: OpenClaw gateway running on `:18789`; the triage-dashboard on `:3456` (for inbox).

```bash
# 1. Copy the Odysseus frontend into ./frontend (one-time / when it changes)
scripts/sync-frontend.sh

# 2. Install + run the backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app:app --reload --port 8800

# 3. Open http://127.0.0.1:8800  (or expose over tailnet with --host 0.0.0.0)
```

The gateway password is read at runtime from `~/.openclaw/openclaw.json`
(`gateway.auth.password`) — it is never stored in this repo. Override any setting via env
(`OPENCLAW_GATEWAY_WS`, `OPENCLAW_GATEWAY_PASSWORD`, `OPENCLAW_SESSION_KEY`, `TRIAGE_URL`).

### Optional dependencies

- **pandoc** (optional, for Documents → "Export as Word"): the binary release is
  installed at `/usr/local/bin/pandoc` (3.6.3). Without it the export button
  falls back to a lower-fidelity client-side converter. On the 8GB mini prefer
  the binary release over a brew source build:
  https://github.com/jgm/pandoc/releases
- `DOCS_STALE_DAYS` (default 4): days before an in-flight document surfaces
  as a nudge in the Inbox tab.

## Layout

```
backend/        FastAPI app + the bridge (new code)
  app.py        routes; serves the SPA; stubs
  bridge.py     OpenClaw gateway WS client → Odysseus SSE  ← the heart of it
  inbox.py      proxy to the triage unified feed
  config.py     runtime config (reads ~/.openclaw/openclaw.json for secrets)
frontend/       the reused Odysseus SPA (synced, gitignored — not vendored)
docs/           design spec
scripts/        sync-frontend.sh
```
