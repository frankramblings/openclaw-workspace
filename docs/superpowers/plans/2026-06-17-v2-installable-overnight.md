# v2 — "Installable on anyone's OpenClaw": overnight completion run

**Date:** 2026-06-17 (overnight, autonomous)
**Branch:** `v2-installable` (worktree `.worktrees/v2-installable`, off `main`)
**Driver:** subagent-driven-development (fresh implementer + task reviewer per task)
**Baseline:** 381 tests green on `main`.

## Goal

Finish making the workspace installable by someone else against **their own
OpenClaw + their own agent**. Phase 1 (robust connect to any gateway / any agent
id) is already merged to `main`. This run completes Phase 2 (generalized
integrations), Phase 3 (packaging), an installability/genericization pass over the
week of feature work that landed since Phase 1, and the docs + publish prep — so
in the morning the user can review, merge to `main`, run `prepare-public.sh`, push,
and announce.

## Source specs / plans (all in-repo)

- Overall design: `docs/superpowers/specs/2026-06-08-v2-installable-on-any-openclaw-design.md`
- Phase 2 design: `docs/superpowers/specs/2026-06-09-v2-phase2-generalized-integrations-design.md`
- Phase 2a email plan: `docs/superpowers/plans/2026-06-09-v2-phase2a-email.md`
- Phase 2b calendar CalDAV plan: `docs/superpowers/plans/2026-06-09-v2-phase2b-calendar-caldav.md`
- v1 shipping log: `docs/SHIPPING.md`

## Global constraints (bind every task)

- **Backwards-compat invariant.** The maintainer's live install must behave
  identically: agent id resolves to `main`; email reads the existing
  `~/.config/himalaya/config.toml`; calendar defaults to the Google provider with
  existing tokens; inbox is seeded (in gitignored `.data/`) with the current
  collectors. Guard with tests.
- **Secrets discipline.** Secrets never go in tracked files or in `.data/*.json`.
  Passwords/tokens live in mode-600 files under `.data/secrets/` (dir 700) or env.
  A copied `.data/` (minus `.data/secrets/`) must not leak a credential.
- **No maintainer identifiers in tracked files.** The `prepare-public.sh` scan
  (`femanuele|wistia|bespin|bicolor-triceratops|skinny-cloths|/Users/[a-z]`) must
  pass over the publishable tree. Tests use temp paths / generic fixtures.
- **Tests are gateway- and network-free.** Pure-logic units next to the code.
- **TDD.** Failing test first, minimal impl, green, commit.

## Task list (sequential — one worktree, never parallel implementers)

1. **Installability genericization pass.** Remove maintainer-specific assumptions
   that landed since Phase 1. Real code leaks found on `main`:
   - `backend/inbox/sources/slack.py` — `MY_HANDLE` default `"femanuele"` → no
     personal default (env/config; empty default).
   - `backend/tests/test_calendar_invite.py` — `wistia.com` + personal names in
     fixtures → generic `example.com` / generic names.
   - `deploy/ios/*` (GaryApp.swift, GaryWidget.swift, gary-widget.scriptable.js,
     README.md) — hardcoded `bespin.bicolor-triceratops.ts.net:8443` URL + visible
     "Gary" → placeholder `https://YOUR-WORKSPACE-HOST` + `__AGENT_NAME__`-style
     guidance, with a README note to set their own host. (Keep code-internal slugs.)
   - `frontend-overrides/js/inbox.js` — audit the one identifier hit; genericize.
   - Sweep all tracked **code** (not docs) for `/Users/[a-z]` hardcoded paths and
     for new visible "Gary" strings introduced by terminal / email-triage / mobile
     work that should be `__AGENT_NAME__` (keep internal slugs like `handToGary`,
     `data-act="gary"`, `garyimg`).
   - `prepare-public.sh`: the internal `docs/superpowers/{plans,specs}` are riddled
     with `/Users/admin` + tailnet names. Make the publish path exclude
     `docs/superpowers/` from the public branch (they're internal dev artifacts),
     so the scan passes without lossy scrubbing of working docs. Keep
     `docs/ARCHITECTURE.md` etc. (the curated public docs).
   - Done = `git grep -nIE '<patterns>' -- . ':!docs/superpowers/' ':!docs/SHIPPING.md' ':!scripts/prepare-public.sh'`
     is empty; full suite green.

2. **Phase 2a — Email.** Execute `2026-06-09-v2-phase2a-email.md` verbatim
   (`backend/email_config.py` + tests, `scripts/setup.sh --add-email`, docs).
   +7 tests.

3. **Phase 2b — Calendar CalDAV.** Execute
   `2026-06-09-v2-phase2b-calendar-caldav.md` (iCal VEVENT (de)serializer, CalDAV
   client, provider selector keeping Google default, `setup.sh --add-calendar`,
   capability extension, tests).

4. **Phase 2c — Inbox config-driven collectors.** Per Phase 2 design §2c:
   `backend/inbox/settings.py` (`inbox_config()` reading `.data/inbox.json`,
   per-collector accessors, precedence env > inbox.json > default); `items()` runs
   only enabled collectors (+ account-free `documents_stale`); capability =
   inbox enabled AND ≥1 collector enabled; `setup.sh` enable + documented config;
   maintainer seed note. Tests for selection + settings wiring + capability.

5. **Phase 3 — Packaging + minimal optional auth.** `Dockerfile`,
   `docker-compose.yml` (binds 127.0.0.1 by default; gateway URL/password via env;
   optional `~/.openclaw` bind-mount), `.dockerignore`, `CHANGELOG.md`. Minimal
   **optional** auth gate (`WORKSPACE_AUTH_TOKEN`, OFF by default; when set, a
   middleware requires a bearer/cookie token) so Docker exposure is honest — per
   Phase 4 "pull in when Phase 3 exposes the app." Tests for the auth middleware
   (off → open; on → 401 without token, 200 with). Docs of the security model.

6. **Docs + publish prep.** README: "Connecting to your OpenClaw" already exists;
   add/extend "Optional integrations" (email/calendar/inbox), "Running with Docker",
   "Security". `docs/ARCHITECTURE.md`: gateway method-contract table + `MIN_OPENCLAW`
   + the new modules (email_config, calendar selector/caldav, inbox settings, auth).
   `.env.example`: every new knob. Update `docs/SHIPPING.md` progress log + a v2
   section. Validate `prepare-public.sh --yes` builds a clean single-commit branch
   with 0 private identifiers and `docs/superpowers/` excluded.

7. **Final whole-branch review + morning report.** Dispatch the broad code review
   on the most capable model; fix Critical/Important in one wave; write
   `OVERNIGHT-REPORT.md` at repo root (what shipped, test counts, how to review,
   exact publish/announce commands, anything deferred).

## Definition of done (morning)

Fresh clone → `setup.sh --name Aria --yes --skip-connect` → fully branded UI,
backend imports, core tabs work, account tabs cleanly gated; `--add-email` /
`--add-calendar` configure BYO accounts; `docker compose up` runs (localhost);
full suite green; `prepare-public.sh` yields a clean public branch. The user
reviews `v2-installable`, merges, publishes, announces.
