# Changelog

All notable changes to OpenClaw Workspace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased] — v2: installable on any OpenClaw

This milestone (branch `v2-installable`) makes the workspace a first-class
installable product that any OpenClaw user can run against their own gateway,
not just the original maintainer's setup.

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
