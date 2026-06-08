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
- [ ] **2. Setup wizard** `scripts/setup.sh` (interactive + `--name`/`--yes` flags).
- [ ] **3. README rewrite** for a public audience: what it is, prereqs (OpenClaw gateway), quickstart (clone → setup → run), config table, screenshots placeholder, security note (no-auth/Tailscale model), license.
- [ ] **4. LICENSE** (MIT, maintainer as copyright holder).
- [ ] **5. `.env.example`** documenting every config knob (gateway, session keys, domains, agent name, timeouts, optional deps).
- [ ] **6. Deploy template:** `deploy/ai.openclaw.workspace.plist.template` + `scripts/install-launchagent.sh` (paths/user templated, not hardcoded to /Users/admin).
- [ ] **7. Secrets/personal-data audit** of the working tree AND a note on history (no secrets committed — verified once; re-verify before publish). Generalize `wistia.com`/`bespin`/`/Users/admin` defaults to env or clearly-documented placeholders.

## Tier 2 — adoption polish (do if Tier 1 lands)

- [ ] **8. CONTRIBUTING.md + ARCHITECTURE.md** (bridge explained, override system, how to add a tab).
- [ ] **9. Icon generation from the agent name** (initials-based mark fallback so a fresh install isn't stuck with the "Gary helmet").
- [ ] **10. `requirements.txt` pinned + a `make`/`justfile` or `scripts/dev.sh`** for one-command local run.
- [ ] **11. Smoke-test script** `scripts/smoke.sh` (curl /api/config, /api/models, etc.) so an installer can self-verify.
- [ ] **12. GitHub hygiene:** `.github/` (issue template, a CI that runs pytest), top-of-repo badges.

## Progress log (newest first)
- 2026-06-07: Plan created. Verified no committed secrets; OpenClaw agent has no name field (brand is ours). Starting Tier 1 item 1.
