# v2 — Installable on anyone's OpenClaw

**Date:** 2026-06-08
**Status:** Design approved; Phase 1 ready for a plan.
**Builds on:** v1 productization (`docs/SHIPPING.md`) — configurable agent name,
vendored frontend, setup/dev/deploy/publish scripts.

## Goal

v1 made the repo *publishable*. v2 makes it *installable by other people against
their own OpenClaw*. A new user should clone (later: `docker run`), point it at
their OpenClaw gateway, and have everything that can work, work — with clear,
self-diagnosable failure for anything that needs their own accounts.

The headline risk v2 removes: v1 was validated against the maintainer's single
OpenClaw install and personal accounts. Several assumptions are baked in that
break on a different install.

## Non-goals

- Not adding new product surfaces (no new tabs/features for their own sake).
- Not multi-user/multi-tenant. Still one user per install.
- Phase 1 does **not** add authentication (tracked as Phase 4, decided later).

## Decomposition (phased; scripts-first, integrations generalized)

| Phase | Theme | Status |
|---|---|---|
| **1** | **Foundation: robust connect to any OpenClaw** | **specced below** |
| 2 | Generalized integrations (inbox / email / calendar) | outlined |
| 3 | Packaging (Docker, releases) | outlined |
| 4 | Optional auth (needed before remote/Docker exposure) | flagged |

Sequence: 1 → 2 → 3, with 4 pulled in when Phase 3 exposes the app beyond a
trusted network. Each of Phase 2's integrations is its own spec → plan cycle.

---

# Phase 1 — Foundation (detailed)

Five units, each independently testable. They share one theme: **stop assuming
this is the maintainer's machine.**

## 1a. Derive the agent id (kill hardcoded `agent:main:*`)

**Problem.** `backend/config.py` hardcodes the agent id `main` in every session
key (`SESSION_KEY="agent:main:main"`, `WEB_SESSION_KEY="agent:main:web"`,
`INBOX_TRIAGE_SESSION_KEY`, `WEB_SESSION_PREFIX`). OpenClaw's agent id comes from
`agents.list[0].id`; it happens to be `main` for the maintainer but is not
guaranteed. On a different install the web UI would bind to a non-existent
session and chat would silently fail.

**Design.**
- Add `config.agent_id() -> str`: `OPENCLAW_AGENT_ID` env › `agents.list[0].id`
  from `openclaw.json` › `"main"` (last-resort default, logged as a guess).
- Replace the four module-level session-key **constants with functions** (not
  import-time computation — functions re-read env/config and are trivially
  testable; import-time binding would freeze a possibly-stale agent id):
  - `web_session_key()` → `agent:{id}:web`
  - `inbox_triage_session_key()` → `agent:{id}:inbox-triage`
  - `web_session_prefix()` → `agent:{id}:web`
  - `session_key()` (the shared/Signal one) → `agent:{id}:main`
  Env overrides (`OPENCLAW_WEB_SESSION_KEY`, etc.) still win verbatim.
- Update call sites in `bridge.py` / routers that import the constants to call
  the functions. (Audit: grep `SESSION_KEY|WEB_SESSION|TRIAGE_SESSION|WEB_SESSION_PREFIX`.)

**Compatibility.** For the maintainer, `agent_id()` resolves to `main`, so every
key is byte-identical to today — zero behavior change, verified by a test.

**Tests.** `agent_id()` precedence (env / config / default); session-key builders
produce `agent:<id>:*`; an alternate-id config yields alternate keys.

## 1b. Connection config: same-host AND remote

**Problem.** `config.py` reads `~/.openclaw/openclaw.json` for the gateway URL,
port, and password — a same-host assumption. A user whose OpenClaw runs elsewhere
has no such file locally.

**Design.**
- Connection resolution order (per field): env › `.data/connection.json` ›
  `openclaw.json` › default.
- `.data/connection.json` (gitignored, written by setup) holds **non-secret**
  connection info only: `{ "gateway_ws": "...", "agent_id": "...",
  "integrations": { "email": false, ... } }`. The **password stays in env
  (`OPENCLAW_GATEWAY_PASSWORD`) or `openclaw.json`** — never persisted to
  `.data/` — so a copied `.data/` can't leak a credential.
- `config.gateway_password()` unchanged (env › openclaw.json). If neither yields a
  password and the gateway requires one, the doctor (1c) reports it clearly.
- Helpers mirror branding: `load_connection()` / `save_connection(**fields)`.

**Tests.** Resolution precedence; remote case (no openclaw.json, explicit ws+pw
via env) resolves; password never read from connection.json.

## 1c. Doctor / preflight

**Problem.** When it doesn't work on someone's install, there's no way to see
*why*. `smoke.sh` checks local artifacts only.

**Design.** A connection doctor with two faces sharing one implementation
(`backend/doctor.py`):
- **`GET /api/doctor`** → JSON list of checks `{id, ok, detail, hint}`.
- **`scripts/doctor.sh [URL]`** → human-readable pass/fail (curls `/api/doctor`
  if a server is up; otherwise runs the static subset like `smoke.sh`).

Checks (each non-fatal to the others; collect all, then summarize):
1. **gateway reachable** — open the WS to `gateway_ws_url()`; report connect
   errors (refused / DNS / timeout).
2. **auth accepted** — complete the gateway handshake; distinguish "no password
   configured" from "password rejected."
3. **agent id resolved** — `agent_id()` and where it came from (env/config/guess);
   warn on the `main` fallback-guess.
4. **required methods present** — probe the read-only subset of the method
   contract (below) via `bridge.gateway_call`; a method that errors `unknown
   method` ⇒ incompatible/old OpenClaw.
5. **OpenClaw version** — if the gateway exposes a version/hello, record it and
   compare to a documented `MIN_OPENCLAW` (advisory).
6. **local** — Python importable, `frontend/` built, no un-baked `__AGENT_NAME__`
   (fold in the existing `smoke.sh` static checks).

Doctor is **read-only** — it must never send a chat turn or mutate gateway state.

**The gateway-method contract** (documented in the spec + `ARCHITECTURE.md`; the
surface v1 actually depends on):
`chat.send`, `chat.abort`, `chat.history`; `sessions.create/delete/patch/json`;
`models.list`, `models.authStatus`; `cron.list/run/runs/update`;
`skills.status/update`. Probe only the safe read-only ones for check #4
(`models.list`, `skills.status`, `cron.list`, `sessions.json`); the mutating ones
are documented-required but not probed.

**Tests.** Each check maps unreachable/rejected/unknown-method gateway states to
the right `{ok, hint}` (mock `gateway_call`); the aggregate ok-flag is the AND of
fatals; static-only mode works with no server.

## 1d. Onboarding (extend `setup.sh`)

**Problem.** `setup.sh` names the agent and builds the frontend but never verifies
the OpenClaw connection or helps configure it.

**Design.** Add steps after naming (all skippable with `--yes` / flags):
1. **Connect** — detect `~/.openclaw/openclaw.json` (same-host) and offer to use
   it; else prompt for gateway WS URL (+ remind to set
   `OPENCLAW_GATEWAY_PASSWORD`). Write non-secret bits to `.data/connection.json`.
2. **Verify** — run the doctor; print the summary. Don't hard-fail (the gateway
   may be down at setup time) but make red checks obvious.
3. **Choose integrations** — list the optional ones (email/calendar/inbox) with a
   one-line "needs X"; chosen set is written to `connection.json.integrations`.
4. Existing frontend build + next-steps, ending with how to re-run the doctor.

New flags: `--gateway-ws`, `--enable email,calendar`, `--skip-connect`.

**Tests.** Smoke the non-interactive path (`--name X --yes --skip-connect`)
in CI; assert `connection.json` shape. (Interactive prompts stay shell-tested
lightly, as today.)

## 1e. Capability gating

**Problem.** Tabs whose backend needs an account the user doesn't have currently
either error or were hidden by hardcoded maintainer-specific CSS. A generic
install needs this to be **data-driven**.

**Design.**
- **`GET /api/capabilities`** → `{ "chat": {available:true}, "email":
  {available:false, reason:"no himalaya config", hint:"run setup --enable email"},
  ... }`. Each tab's availability is computed server-side from: required gateway
  method present (from doctor cache) ∧ required binary/config/account present ∧
  the integration being enabled in `connection.json`.
- Each backend module exposes a small `capability()` describing its needs, so the
  list is assembled from the modules, not a hardcoded switch.
- **Frontend**: a `frontend-overrides/js/capabilities.js` add-on (same injected-
  `<script>` pattern as `cron.js`/`inbox.js`) fetches `/api/capabilities` at boot
  and hides/disables the rail buttons for unavailable tabs, with a tooltip/"connect"
  hint. Core tabs (chat, memory, skills, cron, sessions, models, notes, documents)
  are always available when the gateway is up.

**Tests.** `capability()` per module returns available/unavailable from a mocked
environment; `/api/capabilities` aggregates; a disabled integration reports
`available:false` even when the binary exists.

## Phase 1 done = definition

A fresh clone, pointed at a *different* OpenClaw (different agent id, same- or
remote-host), runs `setup.sh`, sees a green-or-clearly-explained doctor, and gets
working chat + all core tabs, with account tabs cleanly gated. The maintainer's
own install behaves byte-identically (agent id still `main`).

---

# Phases 2–4 (outline — each its own spec when reached)

## Phase 2 — Generalized integrations
- **2a. Inbox collectors** — replace per-collector env defaults with a config-
  driven model (`.data/inbox.json`: which providers, accounts, internal domains);
  each collector independently enable-able; absent config ⇒ collector off (not
  erroring), surfaced via capabilities.
- **2b. Email** — generalize `email_himalaya.py` beyond Gmail-app-password to any
  himalaya/IMAP account; a connect wizard writing himalaya config; capability-gated.
- **2c. Calendar** — bring-your-own Google OAuth client creds and/or CalDAV,
  instead of reusing the maintainer's `google-calendar-mcp` token; capability-gated.

## Phase 3 — Packaging
- `Dockerfile` + `docker-compose.yml`: gateway URL/password via env; optional
  `~/.openclaw` bind-mount for same-host; the image runs `setup.sh --yes` at build
  or first boot. Versioned releases (git tags + `CHANGELOG.md`). `prepare-public.sh`
  already produces the clean public history.

## Phase 4 — Optional auth (flagged)
- A minimal shared-token / basic-auth layer, **off by default**, enabled by env
  (`WORKSPACE_AUTH_TOKEN`). Required before Docker/remote exposes the app beyond a
  trusted network (the app has shell-capable tools via the agent). Revisit when
  Phase 3 lands; design then.

---

# Cross-cutting

- **Testing:** every unit ships gateway-free pure-logic tests next to the code in
  `backend/tests/` (mock `gateway_call`); CI gains the `--skip-connect` setup +
  capabilities assertion. No live-gateway tests in CI.
- **Docs:** `ARCHITECTURE.md` gains the method-contract table + `MIN_OPENCLAW`;
  README gains a "Connecting to your OpenClaw" section (same-host vs remote) and a
  "Troubleshooting → run the doctor" pointer.
- **Backwards-compat invariant:** at every step, the maintainer's install (agent
  id `main`, same-host, live `frontend/` = Gary) must behave identically — guarded
  by tests and the byte-identical session-key check.

# Risks / open questions

- **Method-contract drift across OpenClaw versions.** We document + probe, but we
  can't test against versions we don't have. Mitigation: doctor surfaces unknown-
  method clearly; `MIN_OPENCLAW` is advisory until we can pin a real floor.
- **Remote-host password handling.** Keeping the password out of `.data/` means
  remote users must set an env var; the doctor must make that obvious. Acceptable.
- **Capability source of truth.** Availability depends partly on the doctor's
  cached gateway probe; define a short TTL + a manual re-probe so a gateway that
  comes up after boot is picked up without restart.
