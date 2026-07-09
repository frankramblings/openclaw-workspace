# Iceberg Audit — under-the-hood gaps and the plan to fill them

**Date:** 2026-07-08
**Method:** four parallel read-only audits (backend architecture, frontend/PWA, testing/CI, ops/data lifecycle) over the full repo plus the live machine (systemd units, journals, `~/.openclaw`, `/tmp`). All numbers verified by running commands, not read off docs.

---

## The shape of the iceberg

The surprise is *where* the mass is. The application layer is **stronger than "early-stage"**: 683 real behavioral backend tests (all green), a genuinely resilient gateway bridge (warm-socket handoff, stall-retry with fresh idempotency keys), a solid auth gate, clean secrets hygiene, a well-reasoned service-worker caching strategy, and a modular 10.5K-line redesign frontend.

The submerged mass is almost entirely in three places:

1. **The operational envelope is near zero.** No state backup (27 GB of `~/.openclaw` + all sessions/memory/secrets would die with the disk), no alerting (a 2-hour gateway crash-loop on 2026-07-02 went completely unnoticed), the production systemd units aren't in version control, and the `/tmp` quota bomb that caused that outage has no automated mitigation — two orphan render dirs (~730 MB) are sitting in `/tmp` right now.
2. **Dead weight shipped every deploy.** The retired "classic" UI (~86K lines, a 1.1 MB stylesheet, plus 23 test files) is still built, rebranded, and offline-precached on every install — roughly 3–4× the payload the live redesign needs, and it carries the legacy 403-`innerHTML` XSS surface.
3. **Quality gates that exist but aren't wired.** 24 JS test files run nothing in CI (3 are red right now and nobody noticed); zero lint/type-check anywhere; feature-branch pushes don't trigger CI; `main` is 47 commits ahead of origin on one machine.

---

## Above the waterline (verified strengths — don't rebuild these)

- **Backend test suite:** 683 tests, ~72 s, genuinely behavioral (SSE frame replay, named regression guards). `app.py`, `terminals.py`, `bridge.py`, auth, calendar, email, inbox all have real coverage.
- **Gateway resilience** (`backend/bridge.py`): warm-connection liveness, one-shot fresh-socket retry, 240 s stall abort + retry with fresh idempotencyKey + `stall_retry` SSE frame. Built around the gateway's 4–5 min cold boot.
- **SIGTERM hang: already mitigated in production config.** `~/.config/systemd/user/openclaw-workspace.service` has `--timeout-graceful-shutdown 2`, `TimeoutStopSec=5`, `KillMode=mixed` (kills the SIGTERM-swallowing interactive shell children — two orphan `fish -i` are in the cgroup right now, confirming the mechanism). Restarts cost ≤5 s of 502s, by design. The `CancelledError` tracebacks in the journal are expected force-closes, not faults.
- **Auth gate** (`backend/auth_gate.py`): constant-time compare, gates WebSocket handshakes too (the README's "HTTP only" warning is stale — it undersells the gate).
- **Secrets hygiene:** nothing sensitive ever committed (verified via `git log --all --diff-filter=A`); `0600` perms throughout; gateway password never persisted to `.data/` by allowlist design (`config.py:214-230`).
- **Service worker strategy** (`frontend-vendor/sw.js`): network-first app shell with 4.5 s timeout, cache-first assets, never caches `/api/*`, content-hashed cache name, correct update flow (`skipWaiting` + `controllerchange` reload guard).
- **Redesign frontend** (`frontend-overrides/js/redesign/`, 10.5K lines): real ESM, single state object → render pattern, escape-first markdown (`redesign/markdown.js`), chat-turn errors surfaced to the user, server-side turn recorder + resume-by-cursor survives deploys.
- **Metadata store writes are atomic** (temp-file + `os.replace`): `sessions_store`, `config`, `followup`, `inbox/state`, `terminals`, `memory`, `branch_context`.

---

## Below the waterline

### Tier 0 — Active hazards (outage / data-loss class)

| # | Finding | Evidence |
|---|---------|----------|
| 0.1 | **`/tmp` quota bomb, unmitigated.** Gateway (`TMPDIR=/tmp`, tmpfs with `usrquota`) writes `rf_*`/`ge_*` render dirs; nothing reaps them (crontab empty, no tmpfiles override; system default is 10-day age-based — useless vs. a quota that fills in hours). 20 gateway `uncaught_exception` dumps in 2 h on 07-02, all `UNKNOWN: unknown error, write` = libuv's EDQUOT signature → crash-loop. ~730 MB of orphans present now. | `~/.openclaw/logs/stability/`, `findmnt /tmp`, `/tmp/ge_7w_4usug`, `/tmp/rf_pn94jaiu` |
| 0.2 | **Zero state backup.** Code is on GitHub; `.data/` (sessions, chat index, inbox state), `~/.openclaw` (memory, agents, config, plaintext API keys), and `~/.config/openclaw-secrets/` have no backup of any kind. Also: `main` 47 commits unpushed; the whole chat-strip feature (source + tests) uncommitted. | `crontab -l` empty; no backup script in repo; `git status` |
| 0.3 | **Silent session-library wipe path.** `sessions_store._load()` swallows `JSONDecodeError` → returns empty → next `_save()` overwrites the store with `{"sessions": []}`. No quarantine, no `.bak`, no alert. | `backend/sessions_store.py:30-40` |
| 0.4 | **Vault content writes are non-atomic and unlocked.** Notes/documents/research bodies use in-place `write_text` (no temp+rename), and the vault is written by *both* the workspace and the agent process with no `flock` — torn-read/lost-update race + truncation on crash/disk-full. The atomic pattern exists in the metadata stores but never reached the content writers. | `backend/vault_store.py:81`, `documents.py:80`, `research.py:477,626,731`, `app.py:746` |
| 0.5 | **Plaintext key sprawl.** ~25 unpruned `openclaw.json.bak-*` copies, each containing full API-key material, accumulating in `~/.openclaw`. | `ls ~/.openclaw` |

### Tier 1 — Missing safety nets (would have caught/contained Tier 0)

| # | Finding | Evidence |
|---|---------|----------|
| 1.1 | **No alerting or scheduled health checks.** `doctor.py`, `monitor.py`, `smoke.sh` all exist and are good — nothing runs them. The 07-02 crash-loop paged no one. No `WatchdogSec`/`sd_notify`, so a wedged-but-alive uvicorn is never restarted. | `systemctl --user list-timers` (only token-refresh + podcast timers) |
| 1.2 | **JS tests invisible to CI.** 24 test files, Node built-in runner works (`node --test __tests__/*.test.js` → 146/149 pass) — but CI runs only pytest + build smoke. **3 tests are red right now**: 1 in `redesign-markdown.test.js` (fenced code block escaping), 2 in `msg-tools.test.js` (toolbar binding). | `.github/workflows/ci.yml` |
| 1.3 | **Zero static analysis.** No ruff/mypy/eslint/prettier/pre-commit anywhere. CI also doesn't run on feature-branch pushes (only main/public + PRs) — daily work is unguarded. | repo-wide grep |
| 1.4 | **Production deployment is not in the repo.** The real systemd units (`openclaw-workspace.service`, `openclaw-gateway.service`) live only in `~/.config/systemd/user/`. `deploy/` contains macOS launchd + Docker artifacts only; README documents the Mac path. No written deploy runbook (`git pull → sync-frontend → restart`). | `git ls-files deploy/` |
| 1.5 | **Environment not reproducible.** `backend/requirements.txt` is floor-pinned only (no lockfile), and heavy lazy imports (`openpyxl`, `watchfiles`, PDF parsers, embedding deps) are undeclared — features silently no-op if absent. | `backend/requirements.txt`, `app.py:570`, `workspace_watch.py:126-128` |
| 1.6 | **Dual openclaw install = likely cause of the openai/google/brave plugin failures.** Gateway runs system `/usr/lib/node_modules/openclaw` (v2026.6.8) but management/auth commands have been run through the nvm copy too — auth/plugin state written under one prefix isn't necessarily read by the binary that actually runs. Reconcile before more debugging. | `config-audit.jsonl`, `which openclaw` |

### Tier 2 — Structural debt (taxes velocity, grows with time)

| # | Finding | Evidence |
|---|---------|----------|
| 2.1 | **Classic UI is dead-but-shipped.** Live UI is the redesign at `/`; classic (~86K lines incl. 9.5K-line `document.js`, 1.1 MB `style.css`, 172 KB legacy `app.js`) is still built, sed-rebranded, served at `/classic`, and **offline-precached (~230 entries, ~16 MB)** — including 23 `__tests__/*.test.js` files shipped to production. 403 legacy `innerHTML` sites vs 27 in the redesign. | `sync-frontend.sh:371-376`, `frontend/sw.js:17`, `app.py:1552-1554` |
| 2.2 | **Blocking I/O on the async hot path.** `chat_stream` runs ffmpeg HEIC conversion and openpyxl/PDF text extraction inline (not `asyncio.to_thread`) — one file-heavy message stalls every concurrent SSE stream on the single event loop. The correct pattern already exists in `notes.py`/`documents.py`/`chat_search.py`. | `app.py:846→480-484`, `app.py:851→560+` |
| 2.3 | **`app.py` god-module (1,562 lines).** Chat-turn engine (~275-line handler), attachment subsystem (~330 lines), title generation, SPA HTML rewriting all in the entrypoint. Plus a catch-all `GET /api/{path:path}` → `200 []` that masks 404s from client bugs. | `app.py:807-1081, 474-806, 1448-1450` |
| 2.4 | **Lifespan doesn't own its tasks.** Shutdown cancels 3 tasks but orphans the `workspace_watch` loop, per-turn recorder tasks (`_TURN_TASKS`), and fire-and-forget `_BG_TASKS` — teardown is delegated entirely to uvicorn's 2 s force-close. | `app.py:74-103, 150, 168` |
| 2.5 | **Observability near zero in-process.** 133 broad `except Exception` swallows (mostly deliberate but unlogged); only 3 of 40 modules log at all; no `logging.dictConfig`; `/api/health` is a static echo that probes nothing. | grep counts; `app.py:215` |
| 2.6 | **Config: 63 env vars, zero validation, no schema versions.** Misconfig surfaces as a deep runtime failure; every JSON store degrades malformed files to empty defaults (field rename = silent data loss, not a migration). | `config.py:48-135` |
| 2.7 | **Terminal loopback trust gap.** With no `WORKSPACE_AUTH_TOKEN` (default local mode), the PTY WebSocket trusts any loopback client — behind a non-Tailscale same-host proxy (nginx/Caddy), forwarded clients appear as 127.0.0.1 and can get a real shell. | `terminals.py:48-64, 101-105` |
| 2.8 | **Build pipeline fails silently.** `sync-frontend.sh` anchor-patches print `SKIP … (upstream changed)` and continue → a vendor bump ships half-branded with no failing gate. `dev.sh` only syncs when `frontend/index.html` is missing (the "why isn't my edit showing up" trap). No bundling/minification; no upstream-revision marker on `frontend-vendor/`. | `sync-frontend.sh:247-310, 350-354`; `dev.sh:32-34` |
| 2.9 | **Branch/worktree rot.** 4 merged branches deletable; 3 orphaned unregistered `.worktrees/` checkouts eating disk; 3 unmerged branches ~780 commits behind (`calendar-rsvp`, `v2-phase2a-email`, `v2-phase2b-calendar`); 1 prunable stale worktree ref. | `git worktree list --porcelain`, merge-base analysis |
| 2.10 | **Backend test blind spots.** `research.py` agent engine + all 4 routes untested (791 loc, runs live agents); `jobs.py`, `research_render.py`, `workspace_watch.py`, `settings_status.py` zero tests; `memory.py` barely. Frontend has no global error boundary (`window.onerror`/`unhandledrejection` absent — uncaught render throw = silent half-dead UI). | test-file cross-reference |
| 2.11 | **Docs drift.** CONTRIBUTING says "160+ tests, ~2 s" (reality: 683, ~72 s). README documents macOS deployment + understates the auth gate. Docker path unbuilt by CI since Jun 17 — unverified, drifting. | `CONTRIBUTING.md:12` |

---

## The plan

Ordered so each phase makes the previous one's failure mode survivable. Estimates are focused-work time.

### Phase 0 — Stop the bleeding (½ day)

1. **Push `main`** (47 commits exist on one disk) and **commit the chat-strip feature** (source + 16 passing tests are untracked).
2. **Defuse `/tmp`:** set `Environment=TMPDIR=%h/.cache/openclaw-tmp` in `openclaw-gateway.service` (real disk, no quota) **and** add a user timer/tmpfiles rule reaping `/tmp/rf_*` `/tmp/ge_*` older than 1 h. Delete the two current orphans.
3. **Fix or quarantine the 3 red JS tests** so the suite is green before it becomes a CI gate.

### Phase 1 — Safety nets (2–3 days)

4. **State backup:** nightly restic/borg user timer covering `.data/`, `~/.openclaw` (excluding regenerable caches), `~/.config/openclaw-secrets/`, to another host/tailnet node. Prune the ~25 plaintext `openclaw.json.bak-*` files as part of it.
5. **Alerting:** user timer running `scripts/doctor.sh` every few minutes → push notification on failure (gateway down, EDQUOT, wedged app). Add `WatchdogSec` + `sd_notify` to the unit. This is what turns the next 2-hour crash-loop into a 5-minute one.
6. **CI:** add `node --test frontend-overrides/js/__tests__/*.test.js` job; add `ruff check`; trigger on all branch pushes. Optional: `docker build` smoke or explicitly mark Docker best-effort.
7. **Version-control the real deployment:** copy both live systemd units into `deploy/systemd/`, write the 10-line deploy runbook, fix README's Mac-era instructions.
8. **Reproducibility:** commit a lockfile (`pip freeze` or `uv pip compile`), declare the lazy deps (`openpyxl`, `watchfiles`, parsers) as extras.
9. **Reconcile the dual openclaw install** (system vs nvm), re-run plugin/auth through the winner, verify openai/google/brave load — closes the open question from 07-02.

### Phase 2 — Correctness hardening (1 week)

10. **Atomic + locked vault writes:** route `vault_store`/`documents`/`research` content writes through the existing temp+`os.replace` helper; add `flock` for agent-shared files.
11. **Corruption quarantine:** on `JSONDecodeError`, rename the bad file to `*.corrupt-<ts>` and alert instead of silently rebuilding empty (kills the session-library wipe path).
12. **Event-loop hygiene:** wrap attachment/HEIC/office extraction in `asyncio.to_thread`; cancel `workspace_watch`, `_TURN_TASKS`, `_BG_TASKS` in lifespan shutdown.
13. **Minimal observability:** one `logging.dictConfig` at startup; add `log.warning(exc_info=True)` to the persistence/turn-close swallows; make `/api/health` probe gateway socket + disk headroom.
14. **Close the terminal loopback gap:** require explicit token or trusted-proxy allowlist for the PTY WS even in tokenless mode.
15. **Startup config validation** for the load-bearing subset of the 63 env vars; stamp JSON stores with `schema_version`.

### Phase 3 — Debt paydown (ongoing, ordered by leverage)

16. **Retire classic UI from the build:** exclude legacy modules + `__tests__` from the sync/precache globs (~3–4× smaller install, removes the 403-`innerHTML` surface); delete the vendor tree once redesign parity is confirmed.
17. **Make the build fail loudly:** non-zero exit on anchor-SKIP; `dev.sh` always re-syncs (or watches `frontend-overrides/`); record the upstream Odysseus revision in `frontend-vendor/`.
18. **Frontend error boundary:** `window.onerror` + `unhandledrejection` → recoverable toast + backend log line.
19. **Split `app.py`:** extract the turn engine and the attachment subsystem; replace the `GET /api/{path:path}` → `[]` catch-all with 404.
20. **Test the untested:** `research.py` orchestration core, `jobs.py`, `memory.py`.
21. **Branch hygiene:** delete 4 merged branches, prune orphaned `.worktrees/`, decide fate of the 3 ~780-behind branches (salvage or close).
22. **A11y/keyboard pass on the redesign** while it's still 10K lines; **esbuild pass** for minification when payload matters.
23. **Docs truth pass:** CONTRIBUTING test numbers, README auth-gate description, deployment section.

---

## One-line summary

The boat is better-built than "early-stage" implies — but it has no lifejackets: no backup, no alerts, an armed `/tmp` bomb with a proven detonation, and a third of the cargo is a dead UI it still hauls on every deploy. Phases 0–1 (≈3 days) buy survivability; everything after that is compounding velocity.
