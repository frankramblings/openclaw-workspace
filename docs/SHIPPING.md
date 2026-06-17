# Shipping checklist — make openclaw-workspace a public product

Goal: turn this single-user workspace into a product others can install on top of
their own OpenClaw, public-able this week. Headline feature: **name your agent once
at setup** (the maintainer's is "Gary") and have the name propagate everywhere.

This file is the source of truth for the ship effort. Each work session reads it,
picks the top unchecked item, ships it, checks it off, commits.

## Design decisions (locked)

- **Agent name is workspace branding, not OpenClaw config.** OpenClaw's
  `agents.list[0]` has no `name` field. The workspace owns the brand.
- **Single source of truth:** env `WORKSPACE_AGENT_NAME` → else `.data/branding.json`
  `{"agent_name": ...}` → else default `"Claw"`. `.data/` is gitignored, so a user's
  chosen name (e.g. "Gary") NEVER lands in the public repo.
- **Two propagation paths:**
  1. **Build-time** (static chrome): `frontend-overrides/` files carry a
     `__AGENT_NAME__` token; `scripts/sync-frontend.sh` substitutes the configured
     name at sync time (and the `Odysseus → <name>` sed uses it too).
  2. **Runtime** (dynamic JS / API): `GET /api/config` returns `{agent_name, ...}`.
- **Setup wizard** (`scripts/setup.sh`): prompts for the agent name (+ optional
  accent color, internal email domain), writes `.data/branding.json`, runs the
  frontend sync, prints next steps. Non-interactive flags for automation.
- Keep the maintainer's live deploy working throughout (it reads the same config;
  `.data/branding.json` with `agent_name: "Gary"` reproduces today's behavior).

## Tier 1 — blocks public release

- [x] **1. Agent name configurable + propagated.** DONE 2026-06-07.
  - [x] `config.py`: `agent_name()`/`accent_color()` (env → branding.json → "Claw"); `load_branding`/`save_branding` for `.data/branding.json`.
  - [x] `app.py`: `GET /api/config` → `{agent_name, accent}`.
  - [x] Tokenized `frontend-overrides/`: visible `Gary` → `__AGENT_NAME__`; renamed `startGaryApp`→`startWorkspaceApp`, `_setGaryFavicon`→`_setBrandFavicon`; kept `handToGary`/`gary` slugs.
  - [x] `sync-frontend.sh`: computes name, bakes `__AGENT_NAME__`, `Odysseus → <name>` sed uses it.
  - [x] Verified: name=Gary → identical to today (0 stray tokens, manifest/title/app.js all "Gary"); name=Jarvis → fully rebranded, slugs stable. 7 new tests in `test_branding.py`, full suite 161 green.
  - Note: runtime `/api/config` exists as a bonus; static bake fully covers correctness, so no frontend boot-fetch dependency was needed (lower risk).
  - `.data/branding.json` seeded with `agent_name: Gary` to preserve the maintainer's live deploy.
- [x] **2. Setup wizard** `scripts/setup.sh` — interactive + `--name`/`--accent`/`--yes`/`--no-sync`; re-runnable to rename. DONE 2026-06-07.
- [x] **3. README rewrite** for a public audience (what/why, requirements, quickstart, security model, config table, layout, license). DONE 2026-06-07.
- [x] **4. LICENSE** — MIT, "The OpenClaw Workspace authors". DONE 2026-06-07.
- [x] **5. `.env.example`** — every knob, grouped, all commented-out (sensible defaults). DONE 2026-06-07.
- [x] **6. Deploy template** `deploy/ai.openclaw.workspace.plist.template` + `scripts/install-launchagent.sh` (templated paths, 127.0.0.1 default, --uninstall, tailscale-serve hint). Renders to a valid plist (plutil OK). DONE 2026-06-07.
- [x] **7. Secrets/personal-data audit.** No committed secrets (verified). Genericized runtime defaults: inbox internal/slack domains → example.com/example.slack.com, obsidian VAULT → ~/.openclaw/workspace/Meetings, mcporter bin → PATH/`mcporter`. Scrubbed the maintainer's email + company + tailnet names from all tracked docs/tests. **Maintainer's live values pinned in the LaunchAgent env** (WORKSPACE_AGENT_NAME/INBOX_INTERNAL_DOMAIN/SLACK_DOMAIN/INBOX_MEETINGS_DIR) so the running deploy is preserved across the next restart. DONE 2026-06-07.
  - ⚠ Before publishing: re-run the secret scan, and decide whether to squash git history (the scrub cleans the working tree but old commits still contain the identifiers). See Tier-2 note.

## Tier 1.5 — ship blockers found during the build

- [x] **Vendor the frontend (a fresh clone had NO UI).** `frontend/` is gitignored
  build output and upstream Odysseus was deleted, so a clone couldn't render
  anything. Fix: committed a **neutral vendor base** `frontend-vendor/` (the role
  `$ODYSSEUS_STATIC` played) — names reverted to "Odysseus"/`__AGENT_NAME__` tokens,
  override-derived files removed (re-added at sync). `sync-frontend.sh` now syncs
  from it (override via `ODYSSEUS_STATIC`), and `WORKSPACE_BUILD_DEST` lets you
  build to a custom dir. Added `frontend-vendor/THIRD-PARTY.md` attributions.
  Verified: clean build from vendor → name=Jarvis fully rebrands all 169 files,
  0 stray tokens, slugs intact; live `frontend/` (Gary) untouched. (User decision:
  *vendor it.*) DONE 2026-06-08.

## Pre-publish step (one command, at publish time)

`main` keeps full history (with the maintainer's identifiers in old commits, now
scrubbed from the working tree). To publish cleanly **without** leaking that
history, run:

```bash
scripts/prepare-public.sh          # builds a clean single-commit `public` branch
git push <remote> public:main      # publish that, not main
```

`prepare-public.sh` (user chose squash-to-one-commit) is **non-destructive**: it
leaves `main` alone and builds an orphan `public` branch = one commit of the
current tree. It refuses to run if a private-identifier scan finds anything or if
`.data/`/`frontend/`/`.env` are tracked. Verified 2026-06-08: produces a 1-commit,
274-file branch, 0 private files, main untouched.

## Tier 2 — adoption polish (do if Tier 1 lands)

- [x] **8. CONTRIBUTING.md + ARCHITECTURE.md** — bridge, vendor/override/bake flow, branding flow, how to add a tab. DONE 2026-06-08.
- [~] **9. Icons.** De-Garyed the icon tooling (`gary.src.svg`→`brand.src.svg`, `gary-icon-gen`→`brand-icon-gen`, comments). Default mark is a neutral line-art helmet; documented how to swap `brand.src.svg` + regenerate. **Deferred:** auto initials-from-name generation (genuine v2 — needs SVG synthesis + PNG resizing per install).
- [x] **10. Deps + one-command run.** `requirements.txt` now carries version floors (with tested-against notes); `scripts/dev.sh` does venv→deps→frontend→`uvicorn --reload` in one shot. DONE 2026-06-08.
- [x] **(portability)** `sync-frontend.sh` was macOS-only (`sed -i ''`). Added a `sedi()` wrapper that detects GNU vs BSD sed, so `setup.sh`/build work on Linux too (CI runs on ubuntu). DONE 2026-06-08.
- [x] **11. Smoke-test script** `scripts/smoke.sh` — static checks (branding set, frontend built, no stray tokens, backend imports, gateway config) + optional live `/api/config` & `/api/health` probes. DONE 2026-06-08.
- [x] **12. GitHub hygiene:** `.github/workflows/ci.yml` (pytest on 3.11–3.13 + a build/smoke job) and a bug-report issue template. DONE 2026-06-08. (Badges: add after the repo URL is known.)

**VALIDATED 2026-06-08:** fresh `git clone` → `scripts/setup.sh --name Aria --yes`
produces a fully-branded 169-file UI (0 stray tokens) and the backend reads the new
name. The end-to-end install story works for a new user. (Live deploy still runs the
pre-branding backend; restarting it activates `/api/config` + the new code — deferred
to avoid a cold-start stall, behavior preserved via the pinned plist env.)

## Progress log (newest first)
- 2026-06-07: **Tier 1 COMPLETE** (items 1-7). Agent-name feature shipped; setup wizard; README/LICENSE/.env.example; LaunchAgent template + installer; personal-data scrub with live deploy preserved via plist env. Full suite 161 green. Moving to Tier 2.
- 2026-06-07: Plan created. Verified no committed secrets; OpenClaw agent has no name field (brand is ours). Starting Tier 1 item 1.

## v2 — installable on any OpenClaw (2026-06-17)

**Phase 1 (merged to main):** all Tier 1 + Tier 2 items above — agent-name
branding, setup wizard, frontend vendor + override/bake pipeline, README/LICENSE,
LaunchAgent template, personal-data scrub, ARCHITECTURE.md, smoke/CI scripts,
Docker + optional auth gate. Verified: clean clone → setup → fully-branded UI.

**Phase 2a — email config:** `email_config.py` renders a himalaya account block
and writes the mode-600 password file; `setup.sh --add-email` interactive. Supports
Gmail app-password and generic IMAP/SMTP. Secrets in mode-600 files, never in JSON.

**Phase 2b — calendar CalDAV:** `calendar_caldav.py` (CalDAV client) + `ical.py`
(dependency-free VEVENT (de)serializer) + `calendar_config.py` (provider selector,
default google) + `calendar.py` (provider-selecting router). `setup.sh --add-calendar`
supports both `caldav` (universal: Google, iCloud, Fastmail, Nextcloud) and `google`
(OAuth). Existing Google Calendar path refactored to plain provider functions.

**Phase 2c — inbox config-driven:** `inbox/settings.py` + `.data/inbox.json` let
each collector (Gmail, Slack, Asana, Obsidian) be enabled/disabled and tuned per
install. Default: all on (existing installs unchanged). Env vars override JSON.
`auth_gate.py` optional pure-ASGI token gate added (`WORKSPACE_AUTH_TOKEN`, off by
default, SSE-safe).

**Phase 3 — Docker + optional auth:** `Dockerfile` + `docker-compose.yml` +
`.env.example` expanded; `WORKSPACE_AUTH_TOKEN` wired end-to-end; streaming
regression test added.

**Installability genericization pass:** `config.agent_id()` / `load_connection()`
precedence chain (env > `.data/connection.json` > `~/.openclaw/openclaw.json`);
`doctor.py` + `/api/doctor` + `scripts/doctor.sh` read-only preflight; config-driven
Slack keychain account + obsidian owner name (no more hardcoded identifiers);
`capabilities.py` + `/api/capabilities` data-driven tab gating.

**Test suite:** full suite green at ~473 tests. Publish path validated (see below).

**Publish path:** `scripts/prepare-public.sh --yes` builds a clean orphan `public`
branch (single commit, no history, private identifiers and `docs/superpowers/`
internal planning docs stripped). Identifier scan must be empty before the script
proceeds. Push `public:main` to a public remote.
