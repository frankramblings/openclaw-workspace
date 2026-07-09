# Iceberg Remainder — 2026-07-09 re-audit + gap-fill plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close what remains after the 2026-07-08 hardening wave: land stranded branches, finish the three partial fixes, add the missing web-security/PWA surface, close the ops residue, and retire the classic UI from the build.

**Architecture:** No new subsystems. Every task either finishes a pattern that already exists (`fsutil` guards, `sessions_store` schema stamps, the doctor-alert state machine) or deletes dead weight. Frontend edits go in `frontend-overrides/` (or `frontend-vendor/` for vendored files) and ship via `scripts/sync-frontend.sh`; ops artifacts live in `deploy/systemd/` and install per `deploy/RUNBOOK.md`.

**Tech Stack:** FastAPI + uvicorn (Python 3.14 venv), vanilla-ESM PWA, systemd user units, restic → `sftp:endor`, GitHub Actions (pytest matrix + `node --test` + ruff + build smoke).

## Global Constraints

- Never edit `frontend/` directly — it is generated. Edit `frontend-overrides/` / `frontend-vendor/`, then run `scripts/sync-frontend.sh` (fails loudly on vendor drift; `ODYSSEUS_ALLOW_DRIFT=1` to override deliberately).
- Backend tests: `python -m pytest backend/tests -q` — 809 passing, ~79 s. JS tests: `node --test frontend-overrides/js/__tests__/*.test.js` — 201 passing. Both must stay green at every commit.
- The live service runs from THIS working tree (`WorkingDirectory=~/openclaw-workspace`), currently on `mobile-msg-action-sheet`. A restart executes whatever is checked out — keep the tree green and clean.
- Deploying = Frank's explicit action: merge → `scripts/sync-frontend.sh` → `systemctl --user restart openclaw-workspace` (≤5 s of 502s by design).
- systemd changes: edit under `deploy/systemd/`, install with `cp` per `deploy/RUNBOOK.md`, then `systemctl --user daemon-reload`.
- Gateway restarts cost a 4–5 min cold boot. Nothing in this plan may auto-restart the gateway.

---

## Part 1 — Where the iceberg stands (2026-07-09 re-audit)

Method: three parallel read-only audits (code-side plan-item verification on both branches, live-machine ops verification, fresh-gaps sweep) against the 2026-07-08 audit's 23-item plan. Every claim below was verified by command, not assumed.

### Melted since 07-08 (verified DONE — do not redo)

| 07-08 item | Verified state |
|---|---|
| Push main / commit strays | main == origin/main; only untracked file is the audit doc itself |
| /tmp quota bomb | Gateway `TMPDIR=~/.cache/openclaw-tmp` via drop-in; hourly `openclaw-tmp-reaper.timer`; zero `rf_*`/`ge_*` orphans |
| 3 red JS tests | 201/201 green (26 files) |
| State backup | `openclaw-backup.timer` nightly restic → `sftp:endor`; 3 snapshots, latest 4.14 GiB |
| Alerting | `openclaw-doctor-alert.timer` every 5 min + ntfy; proven (fired DOWN/RECOVERED on 07-08) |
| CI | JS tests + ruff + pytest 3.11/3.12/3.13 matrix, triggers on all branch pushes |
| Deploy in VCS | `deploy/systemd/` (units + drop-ins + 3 ops scripts) + `deploy/RUNBOOK.md`; README Linux section |
| Lockfile | `backend/requirements.lock` + Optional extras block in requirements.txt |
| Dual openclaw install | Reconciled + documented (`~/.openclaw/WHICH-OPENCLAW.md`); peer-symlink repair done 07-08 |
| Vault atomic writes | `fsutil.atomic_write_text` + `file_lock` wired into vault_store/documents/research |
| Corruption quarantine | `fsutil.load_json_guarded` in sessions/config/terminals/inbox stores + 22 tests |
| Event-loop hygiene | Attachment extraction in `asyncio.to_thread`; lifespan cancels watch/turn/BG tasks |
| Observability | `/api/health` probes monitor state + disk/tmp headroom; `exc_info` at 14 persistence sites |
| Terminal loopback gap | `terminals.py:52-105` deny-by-default decision tree |
| Config validation | `config_check.run()` at startup, ~50 vars, 23 tests |
| Build fail-loud | `set -euo pipefail` + FATAL drift gate; `dev.sh` always syncs |
| Error boundary | `redesign/error-boundary.js` (error + unhandledrejection), installed in app.js |
| app.py split | 1,562 → ~1,000 lines; `chat_turn.py` + `attachments.py` extracted; catch-all → 404 |
| research/jobs tests | test_research (26) + test_research_engine (16) + test_jobs (9) |
| a11y pass | focus traps, focus-visible, reduced-motion, keyboard ops (commits 0b20bd7, 74f94bf) |
| Docs truth | CONTRIBUTING/README updated |
| Worktree rot | Single clean worktree; the 3 orphaned `.worktrees/` are gone |

**Also deployed:** the service restarted 2026-07-09 10:39 running `mobile-msg-action-sheet` (⊇ main@ada77cf), so the whole hardening wave is live. Both services healthy, `NRestarts=0`, no stability dumps since 07-03.

### Still submerged

**In-flight work with no owner-decision (Phase A):**
- `mobile-msg-action-sheet`: 36 commits ahead of main, 0 behind, all green — unmerged.
- `msg-branch-edit`: fully contained in the above; deletable after merge.
- `calendar-rsvp`: real unmerged capability (email `.ics` RSVP), 810 behind; salvage decision pending (`docs/plans/2026-07-08-branch-salvage.md`).
- `v2-phase2a-email` / `v2-phase2b-calendar`: identical tips, superseded by main — awaiting explicit close.
- 4 remote-only strays on origin; `iceberg-hardening` == main (deletable).
- Chat-strip: WIP checkpoint committed (reducer + tests green); Chat-Strip-Plan.md phases 2–5 unconfirmed.
- The 07-08 audit doc itself is untracked.

**Partial fixes (Phase B):**
- Quarantine missed two stores: `followup.py:42` and `memory.py:55` still rebuild-empty on corrupt JSON.
- `schema_version` stamped only in sessions + inbox stores; terminals/followups unversioned.
- `watchfiles` is the one lazy dep the extras block forgot (silent no-op file-watcher on floor installs).
- `innerHTML` sinks in the redesign grew 27 → 33; the 6 new ones are unaudited.

**Never-covered surface (Phase C):**
- Zero security response headers (no CSP/X-Frame-Options/nosniff/Referrer-Policy/Permissions-Policy); auth cookie lacks `Secure`.
- Offline navigation fallback only fires for `/` — any deep-link navigation offline gets a browser error page.
- Manifest missing `id` + `shortcuts` (also `share_target`/`screenshots`/iOS splash — optional).

**Ops residue (Phase D):**
- Wedged-but-alive app is alert-only — nothing restarts it (WatchdogSec deliberately not adopted).
- Gateway RSS 4.1G, 7.6G peak/24h, no `MemoryHigh`/`MemoryMax` cap.
- Backup is 1 day old, single remote, restore never exercised; hand-picked include list.
- 5 plaintext-key `openclaw.json.bak*` files persist, regrow on config writes, and land in every snapshot.
- Production serves from the shared dev working tree (unlocked live code path).
- `frontend-vendor/VERSION` exists but records no upstream revision hash.

**The last big mass (Phase E):**
- Classic UI: trimmed from the SW precache (230 → 86 entries) but still built, still shipped (`index-classic.html`, 1.08 MB `style.css`, 24 `__tests__/*.test.js` in `frontend/`), still served at `/classic` (`app.py` `_spa_html("index-classic.html")`), still carrying the 403-`innerHTML` legacy surface.

**Test debt (Phase F):** `memory.py`, `research_render.py`, `workspace_watch.py`, `settings_status.py` have zero dedicated tests.

**New waterline, one line:** nothing left is outage-class within a day's horizon — the remaining iceberg is one merge decision, two half-finished patterns, a missing web-security layer, four ops polish items, and one 86K-line corpse still strapped to the hull.

---

## Part 2 — The plan

### Phase A — Land what's already built (½ day, mostly Frank decisions)

#### Task 1: Commit the audit documents

**Files:**
- Add: `docs/plans/2026-07-08-iceberg-audit.md` (untracked since yesterday)
- Add: `docs/plans/2026-07-09-iceberg-remainder.md` (this file)

- [ ] **Step 1: Commit**

```bash
git add docs/plans/2026-07-08-iceberg-audit.md docs/plans/2026-07-09-iceberg-remainder.md
git commit -m "docs: iceberg audit (07-08) + re-audit and remainder plan (07-09)"
```

#### Task 2: Merge the feature branch, deploy, delete contained branches

**Decision (Frank):** `mobile-msg-action-sheet` is 36 ahead / 0 behind, both suites green, and is what production already runs. Merging is a fast-forward-shaped no-risk promotion.

- [ ] **Step 1: Merge and verify**

```bash
git checkout main
git merge --no-ff mobile-msg-action-sheet -m "merge: mobile msg action sheet + msg-branch-edit + chat-strip WIP"
python -m pytest backend/tests -q          # expect: 809 passed
node --test frontend-overrides/js/__tests__/*.test.js   # expect: 201 pass
```

- [ ] **Step 2: Sync + push + restart (the deploy runbook, `deploy/RUNBOOK.md`)**

```bash
scripts/sync-frontend.sh
git push origin main
systemctl --user restart openclaw-workspace
systemctl --user status openclaw-workspace --no-pager | head -5   # expect: active
```

Leave the service tree checked out on `main` from here on, so prod tracks main by default.

- [ ] **Step 3: Delete fully-contained branches**

```bash
git branch -d msg-branch-edit iceberg-hardening   # both verified contained/identical
git push origin --delete iceberg-hardening mobile-msg-action-sheet msg-branch-edit
```

#### Task 3: Branch triage (decisions recorded, then mechanical)

- [ ] **Step 1 (Frank decides): `calendar-rsvp`** — real capability (parse `.ics` invites, iCal REPLY, `/api/email/rsvp`, read-view calendar block), 5 commits, 810 behind, 3 mechanical conflicts per `docs/plans/2026-07-08-branch-salvage.md`. Recommended: **salvage** by cherry-pick onto main in a worktree; write its own mini-plan at execution time.
- [ ] **Step 2: Close the dead duplicates** (identical tips, reimplemented in main):

```bash
git branch -D v2-phase2a-email v2-phase2b-calendar
```

- [ ] **Step 3: Prune remote strays** — for each of `origin/chat-resume-detached`, `origin/feat/borrow-openclaw-control-ui`, `origin/inbox-classic-port`, `origin/redesign/direction-a-refined-charcoal`: check `git branch -r --merged main`; delete merged ones with `git push origin --delete <name>`; list any unmerged ones for Frank with a one-line content summary before deleting.
- [ ] **Step 4: Keep `public`** — long-lived release-config branch, not rot. Note it in CONTRIBUTING's branch section if absent.

#### Task 4: Chat-strip — finish or park (decision)

State: commit `597f1e0` = WIP checkpoint (reducer, live/chat wiring, tests green, backend allowlist at `bridge.py:1136-1141`); `Chat-Strip-Plan.md` phases 2–5 (rendering, CSS, persistence) unconfirmed.

- [ ] **Step 1:** Diff `Chat-Strip-Plan.md` against the code to mark which phases are actually done.
- [ ] **Step 2 (Frank decides):** finish (execute remaining phases via executing-plans in a dedicated session) or park (add a `## Status: parked <date>, resume at phase N` header to `Chat-Strip-Plan.md`). The shipped WIP is inert and tested either way.

### Phase B — Finish the partial fixes (1 day)

#### Task 5: Quarantine the last two unguarded stores (followups, memory)

**Files:**
- Modify: `backend/followup.py:40-45` (`_load`)
- Modify: `backend/memory.py:53-57` (`_read_json`)
- Test: `backend/tests/test_corruption_quarantine.py` (append; mirror its existing fixtures)

**Interfaces:** consumes `fsutil.load_json_guarded(path, default, *, logger)` — missing/empty file → default (no rename); corrupt → renamed `<name>.corrupt-<ts>` + error log + default.

- [ ] **Step 1: Write the failing tests**

```python
def test_followups_corrupt_file_quarantined(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    store = tmp_path / "followups.json"
    store.write_text("{not json", encoding="utf-8")
    assert followup._load() == {"promises": []}
    assert not store.exists()                      # original moved, not clobbered
    assert list(tmp_path.glob("followups.json.corrupt-*"))

def test_memory_overlay_corrupt_file_quarantined(tmp_path, monkeypatch):
    monkeypatch.setattr(memory, "_OVERLAY", tmp_path / "memory_overlay.json")
    memory._OVERLAY.write_text("{not json", encoding="utf-8")
    assert memory._read_json(memory._OVERLAY, {}) == {}
    assert not memory._OVERLAY.exists()
    assert list(tmp_path.glob("memory_overlay.json.corrupt-*"))
```

- [ ] **Step 2: Run to verify both fail** — `python -m pytest backend/tests/test_corruption_quarantine.py -q` → 2 failures (file still exists / no quarantine glob).
- [ ] **Step 3: Implement**

`backend/followup.py` — replace `_load` (the module already imports `config`; add `fsutil` and a top-level logger, consolidating the section-scoped `import logging` at line 201):

```python
def _load() -> dict:
    return fsutil.load_json_guarded(_store_file(), {"promises": []}, logger=_log)
```

`backend/memory.py` — replace `_read_json`'s body (add `from . import fsutil` and `_log = logging.getLogger(__name__)`):

```python
def _read_json(path: Path, default):
    return fsutil.load_json_guarded(path, default, logger=_log)
```

Note the behavior change is intended: broad `except Exception` no longer masks OSErrors (permissions, EIO) — those now raise, matching the other guarded stores.

- [ ] **Step 4: Run the full backend suite** — `python -m pytest backend/tests -q` → 811 passed.
- [ ] **Step 5: Commit** — `git commit -m "fix: quarantine corrupt followups/memory stores instead of rebuilding empty"`

#### Task 6: Declare the forgotten `watchfiles` extra

**Files:** Modify `backend/requirements.txt` (Optional section, after `python-pptx`).

- [ ] **Step 1:** Add the line, matching the section's comment style:

```
watchfiles>=0.21  # live workspace file-watch (workspace_watch)
```

- [ ] **Step 2:** Verify the lock already pins it: `grep -i watchfiles backend/requirements.lock` → one pinned line (it's installed; only the declaration was missing).
- [ ] **Step 3: Commit** — `git commit -m "deps: declare watchfiles optional extra (lazy import in workspace_watch)"`

#### Task 7: schema_version stamps for terminals + followups stores

sessions (`sessions_store.py:28-52`) and inbox (`inbox/state.py:35-51`) already stamp; replicate for the two remaining mutable stores. Config's branding/connection caches are read-mostly mirrors — skip (YAGNI).

**Files:**
- Modify: `backend/terminals.py` (guarded-load site at ~:568 and its paired save)
- Modify: `backend/followup.py` (`_load`/`_save`)
- Test: `backend/tests/test_corruption_quarantine.py` or the stores' own test files

- [ ] **Step 1: Write failing tests** — for each store: (a) `_save` output contains `"schema_version": 1`; (b) loading a store stamped `schema_version: 99` logs a warning and does not crash. Copy the assertion shape from the existing sessions tests (`grep -rn schema_version backend/tests/`).
- [ ] **Step 2: Implement** — the exact sessions pattern:

```python
SCHEMA_VERSION = 1
# in load:
version = data.get("schema_version")
if isinstance(version, int) and version > SCHEMA_VERSION:
    _log.warning("%s schema_version %s is newer than this app knows how to "
                 "write; fields it doesn't know may be dropped on save",
                 path.name, version)
# in save:
data["schema_version"] = SCHEMA_VERSION
```

- [ ] **Step 3:** Full suite green; commit `feat: schema_version stamps for terminals + followups stores`.

#### Task 8: Audit the 6 new innerHTML sinks

**Files:** `frontend-overrides/js/redesign/task-rows.js:70`, `redesign/mobile/threads-hint.js:41`, `redesign/mobile/mobile-app.js` (3 sites), `redesign/mobile/install-hint.js` (2 sites).

- [ ] **Step 1:** For each sink, trace every interpolated value to its origin. Static/hardcoded → fine. Anything user-, agent-, or server-derived MUST pass through the escape helper in `redesign/markdown.js` (or be assigned via `textContent`).
- [ ] **Step 2:** For each sink carrying dynamic data, add a test in `__tests__/` asserting `<img onerror=…>`-style input renders inert (copy the pattern from `redesign-markdown.test.js`).
- [ ] **Step 3:** Fix any live sink found; record a one-line verdict per file in this doc; commit.

#### Task 9: Small hygiene sweep (independent one-liners)

- [ ] Delete the stale `.data/inbox-state.json.bak-20260626-102048` (100 KB, superseded).
- [ ] Add `pytest-timeout>=2.3` to the venv + CI install step so a hung test can't wedge a run (plain `pytest backend/tests -q` stays the documented command).
- [ ] Note the Python 3.14 `forkpty() … deadlocks` DeprecationWarning (7×, `test_terminals_mcp.py`) in CONTRIBUTING's known-warnings section — informational until upstream guidance exists.

### Phase C — Web/PWA surface (1–2 days)

#### Task 10: Security response headers + Secure cookie

**Files:**
- Create: `backend/security_headers.py`
- Modify: `backend/app.py` (register middleware next to the auth-gate registration)
- Modify: `backend/auth_gate.py:175-176` (cookie string)
- Test: `backend/tests/test_security_headers.py`

**Interfaces:** produces `SecurityHeadersMiddleware(app)` — pure ASGI wrapper, no config beyond `WORKSPACE_CSP_ENFORCE`.

- [ ] **Step 1: Write failing tests** — TestClient `GET /`: assert `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy`, `permissions-policy` present; `content-security-policy-report-only` present by default; with `WORKSPACE_CSP_ENFORCE=1` (monkeypatch) it moves to `content-security-policy`. Assert `/api/health` also carries them (middleware covers all HTTP responses).
- [ ] **Step 2: Implement**

```python
"""Security response headers on every HTTP response.

CSP starts Report-Only so a policy mistake can't brick the installed PWA;
set WORKSPACE_CSP_ENFORCE=1 after a clean soak."""
import os

_STATIC = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
]

_CSP = (b"default-src 'self'; img-src 'self' data: blob:; "
        b"style-src 'self' 'unsafe-inline'; script-src 'self'; "
        b"connect-src 'self' ws: wss:; worker-src 'self'; "
        b"frame-ancestors 'none'")


class SecurityHeadersMiddleware:
    def __init__(self, app):
        self.app = app
        self.enforce = os.environ.get("WORKSPACE_CSP_ENFORCE") == "1"

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(_STATIC)
                key = (b"content-security-policy" if self.enforce
                       else b"content-security-policy-report-only")
                headers.append((key, _CSP))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)
```

Before enabling: `grep -n "<script>" frontend/index.html` — any inline script found must move to a file or the policy gains its hash. Terminal PTY WS is covered by `connect-src … ws: wss:`. No HSTS — the app is served plain-HTTP behind Tailscale; add it only if TLS termination appears.

Cookie (`auth_gate.py`) — append `Secure` when the request arrived over HTTPS (direct or proxied):

```python
hdrs = dict(scope.get("headers", []))
https = (scope.get("scheme") == "https"
         or hdrs.get(b"x-forwarded-proto", b"").decode() == "https")
cookie = (f"{_COOKIE_NAME}={provided}; HttpOnly; SameSite=Lax; "
          f"Path=/; Max-Age={_COOKIE_MAX_AGE}" + ("; Secure" if https else ""))
```

- [ ] **Step 3:** Full suite green. Manual check: open the PWA, watch devtools console for CSP-Report-Only violations for a week before flipping enforce.
- [ ] **Step 4: Commit** — `feat: security response headers (CSP report-only) + Secure cookie over https`

#### Task 11: Offline fallback for all navigations

**Files:** the service worker — locate the canonical edit site first.

- [ ] **Step 1: Investigate where sw.js is edited** — `grep -n "sw.js" scripts/sync-frontend.sh` and `git log --oneline -3 -- frontend-vendor/sw.js frontend-overrides/sw.js`. The precache trim (230→86) landed somewhere; edit that same layer.
- [ ] **Step 2:** In the fetch handler (currently `frontend-vendor/sw.js:73`, `isNav` requires `url.pathname === '/'`), add a generic navigation fallback AFTER the existing root-nav block, keeping the root block's cache-put behavior unchanged (do NOT cache non-root responses under the `/` key — that would poison the shell cache):

```js
// Any other navigation (deep link, /classic) offline → serve the app shell
// rather than the browser error page. Hash routing means the shell can
// render any route once loaded.
if (e.request.mode === 'navigate') {
  e.respondWith(fetch(e.request).catch(() => caches.match('/')));
  return;
}
```

- [ ] **Step 3:** `scripts/sync-frontend.sh`; verify with devtools → Network: Offline → navigate to `/anything` → app shell loads. JS suite green. Commit.

#### Task 12: Manifest `id` + `shortcuts`

**Files:** Modify `frontend-overrides/manifest.json`.

- [ ] **Step 1: Confirm the real hash routes** — `grep -rn "location.hash\|#/" frontend-overrides/js/redesign/app.js | head` (routes are hash-based; shortcut URLs below must match what the router actually handles).
- [ ] **Step 2:** Add after `"scope"`:

```json
"id": "/",
"shortcuts": [
  { "name": "New chat", "url": "/#chat-new",
    "icons": [{ "src": "/static/icon-192.png", "sizes": "192x192" }] },
  { "name": "Inbox", "url": "/#inbox",
    "icons": [{ "src": "/static/icon-192.png", "sizes": "192x192" }] }
]
```

(substitute the verified route strings from Step 1)

- [ ] **Step 3:** Sync, reinstall the PWA on one device, long-press the icon → shortcuts appear. Commit.
- [ ] **Deferred (opt-in, own plan if wanted):** `share_target` (needs a backend POST route + SW pass-through — a real mini-feature), `screenshots`/`categories` (store-listing cosmetics), iOS splash images (`apple-touch-startup-image` set).

### Phase D — Ops residue (1 day)

#### Task 13: Doctor auto-restart escalation (workspace only, never the gateway)

**Files:** Modify `deploy/systemd/bin/openclaw-doctor-alert` (+ reinstall to `~/.local/bin/`).

Today a wedged-but-alive uvicorn alerts forever and waits for a human. Escalate: after 3 consecutive failed workspace probes (≥10 min wedged), restart the workspace service once, with a 1-hour cooldown so a crash-loop can't flap. The gateway is exempt — its restart is a 4–5 min cold boot and `restarting` is a normal state.

- [ ] **Step 1:** Extend the existing atomic state machine (it already tracks `state now` in `$STATE`): add a consecutive-fail counter and cooldown timestamp; on the 3rd consecutive workspace failure and cooldown expired:

```bash
FAILS="$HOME/.cache/openclaw-doctor-alert.fails"   # "count lastrestart_epoch"
RESTART_COOLDOWN=3600
# in the failure branch, only when the *workspace* probe failed:
read -r n last < "$FAILS" 2>/dev/null || { n=0; last=0; }
n=$((n + 1))
if [ "$n" -ge 3 ] && [ $((now - last)) -ge "$RESTART_COOLDOWN" ]; then
  if [ "${DOCTOR_DRYRUN:-0}" = "1" ]; then
    echo "would restart openclaw-workspace"
  else
    systemctl --user restart openclaw-workspace
    notify "AUTO-RESTART: workspace unhealthy for $n probes; restarted"
  fi
  n=0; last=$now
fi
printf '%s %s\n' "$n" "$last" > "$FAILS.tmp" && mv "$FAILS.tmp" "$FAILS"
# in the ok branch: printf '0 %s\n' "$last" > "$FAILS.tmp" && mv "$FAILS.tmp" "$FAILS"
```

- [ ] **Step 2:** `shellcheck deploy/systemd/bin/openclaw-doctor-alert` clean; dry-run test: `DOCTOR_DRYRUN=1 WORKSPACE_URL=http://127.0.0.1:1/api/health bash …` three times → third run prints `would restart`.
- [ ] **Step 3:** Install (`cp` to `~/.local/bin/`), run once live, `journalctl --user -u openclaw-doctor-alert -n 3` shows a clean probe. Commit.

#### Task 14: Gateway memory guardrail

**Files:** Create `deploy/systemd/openclaw-gateway.service.d/memory.conf`; install to `~/.config/systemd/user/openclaw-gateway.service.d/`.

Observed 4.1G RSS / 7.6G peak per 24 h with no cap. `MemoryHigh` reclaims under pressure without killing; `MemoryMax` is a runaway backstop set far above the observed peak because an OOM-kill costs a 4–5 min cold boot.

- [ ] **Step 1:**

```ini
[Service]
MemoryHigh=8G
MemoryMax=12G
```

- [ ] **Step 2:** Apply live without a restart: `systemctl --user set-property openclaw-gateway.service MemoryHigh=8G MemoryMax=12G`, then install the drop-in + `daemon-reload` so it persists across the next natural restart. Verify: `systemctl --user show openclaw-gateway -p MemoryHigh,MemoryMax`.
- [ ] **Step 3:** Watch for a week (`systemd-cgtop --user` / status RSS). If peak keeps climbing toward MemoryHigh, open a leak investigation — the cap is a guardrail, not the fix. Commit.

#### Task 15: Backup — prove restore, prune key sprawl, widen coverage

**Files:** Modify `deploy/systemd/bin/openclaw-backup` (+ reinstall); Modify `deploy/RUNBOOK.md`.

- [ ] **Step 1: Restore drill (never done — the recovery path is unverified):** `restic restore latest --target ~/.cache/restic-drill --include '**/sessions.json'`; verify it parses (`python3 -c "import json;json.load(open(...))"`) and session count ≈ live; then a full-size `restore latest --target` dry-sizing; delete the drill dir. Document the drill as a dated checklist entry in RUNBOOK (repeat quarterly).
- [ ] **Step 2: Prune plaintext key backups** — add a pre-backup step to `openclaw-backup`:

```bash
find "$HOME/.openclaw" -maxdepth 1 -name 'openclaw.json.bak*' -mtime +7 -delete
```

(each is full API-key material; 7-day retention keeps the recent safety copy, stops the sprawl, and stops multiplying keys across snapshots)

- [ ] **Step 3: Coverage review** — add `~/.openclaw/WHICH-OPENCLAW.md` to the include list; confirm the exclusion of `logs/` and caches is deliberate by writing the include/exclude rationale as comments in the script. Commit + reinstall.

#### Task 16: Deploy-checkout policy (decision, then a 5-line guard)

Production executes whatever `~/openclaw-workspace` has checked out — an unlocked live code path (a rebase mid-restart = surprise deploy). Two options: (a) accept single-tree (matches the test-on-live workflow) + add a pre-restart guard; (b) pinned `~/openclaw-deploy` clone on main. **Recommended: (a)** while this is a one-person, one-machine project; revisit (b) if a second contributor/machine appears.

- [ ] **Step 1 (if (a)):** Add to the RUNBOOK restart step:

```bash
git -C ~/openclaw-workspace status --porcelain | grep -q . \
  && echo "⚠ dirty tree — you are about to serve uncommitted code" || true
git -C ~/openclaw-workspace branch --show-current   # confirm it's the branch you mean
```

- [ ] **Step 2:** Record the decision + rationale in `deploy/RUNBOOK.md`. Commit.

#### Task 17: Record the upstream vendor revision

- [ ] **Step 1:** Find the upstream Odysseus checkout/remote the vendor tree was copied from (`git log --oneline -5 -- frontend-vendor/` for the import commits; check any noted source in `frontend-vendor/VERSION`).
- [ ] **Step 2:** Append the exact upstream commit hash + date to `frontend-vendor/VERSION` in prose (do not embed the literal agent-name token — it trips the brand-leak smoke check, see commit 154cc3b). Commit. If the upstream hash is genuinely unrecoverable, record the import date + "hash unknown, next vendor bump must record it".

### Phase E — Retire the classic UI (2–3 days; write its own plan at execution)

The single biggest remaining mass: ~86K lines, 1.08 MB `style.css`, 24 test files shipped to production, the 403-`innerHTML` legacy XSS surface, and a whole parallel UI to reason about — precache-trimmed but still built and served at `/classic`.

#### Task 18: Parity gate → stop shipping → remove route → delete vendor tree

- [x] **Step 1 (Frank, parity gate):** List classic-only capabilities still in use, if any: `grep -n "classic" backend/app.py`, review `index-classic.html` feature surface vs redesign (note: `origin/inbox-classic-port` suggests inbox parity was already ported). One week of redesign-only use with zero `/classic` visits (grep access pattern via journald or add a counter log line to the `/classic` route) = gate passed.

  Scoped to instrumentation + the capability list only (2026-07-09) — see below. Retirement (Steps 2-5) stays deferred pending the soak week; nothing was removed.

#### Parity gate inputs (2026-07-09)

Instrumentation landed: `backend/app.py`'s `/classic` route now emits `_log.info("classic UI served")` on every hit (byte-identical response otherwise), covered by `backend/tests/test_classic_route.py` (200 HTML + exactly one INFO log record containing "classic", via `caplog`). Findings below feed the parity gate; retirement itself stays gated on the soak criteria at the bottom.

**Classic-only capabilities found** — method: `grep -n "classic" backend/app.py`, plus a script/module-include diff of `frontend-overrides/index-classic.html` (2513 lines, full flat `<script>`/`<link modulepreload>` list) vs `frontend-overrides/index.html` (94 lines, loads only `js/redesign/app.js` + `dualDragInit.js` and lazy-loads the rest through its own ESM graph under `js/redesign/{live,mobile}/*.js`):

1. **9 GET endpoints called only by classic's JS** (documented at `app.py:904-907`, the Task 19 legacy-stub block): `/api/fonts/custom`, `/api/signatures`, `/api/contacts/search`, `/api/sessions/archived`, `/api/chat/stream_status/{id}`, `/api/model-endpoints/probe-local`, `/api/document/{id}/export-pdf`, `/api/document/{id}/render-pages`, `/api/email/attachment/{uid}/{index}`. **Verified: all 9 are already dead on the backend.** Each is wired only to `_legacy_get_stub` (`app.py:918`), which returns `[]` plus a deprecation WARNING — none has a real implementation. Classic's own callers (`js/theme.js`, `js/document.js`, `js/emailLibrary.js`, `js/sessions.js`, `js/chat.js`) already silently degrade to empty results / no-ops in production today. This is not a live capability gap — it's inert legacy code on both ends of the wire.
2. **~50 extra flat script/link tags in index-classic.html** with no direct counterpart in index.html's markup (`app.js`/`init.js`, `activity-tree.js`, `admin.js`, `censor.js`, `cookbook.js`, `compare/index.js`, `keyboard-shortcuts.js`, `tourHints.js`/`tourAutoplay.js`, `vaultLinks.js`, `workspace-terminal*.js`, etc.). Expected, not a gap: the redesign lazy-loads the equivalent surface through `js/redesign/app.js`'s own module graph (`live/*.js` has 18 files including `chat.js`, `email.js`, `document-editor.js`, `inbox*.js`, `notes.js`, `calendar.js`, `research.js`, `terminal.js`, `settings.js`; `mobile/*.js` has 11 more) rather than top-level `<script>` tags, so a raw tag diff overstates the difference.
3. **Inbox** — `origin/inbox-classic-port` claim verified rather than trusted: `docs/specs/2026-06-25-inbox-classic-port-design.md` (commit `c029a55`) plus the subsequent `feat(inbox)` commit series (Inbox v2 phases 1-4, entities collector/classifier, triage-with-Gary, swipe-undo) landed in `frontend-overrides/js/redesign/live/inbox.js`, `inbox-detail.js`, `inbox-logic.js`. No inbox-only gap remains.
4. **Document editor** — the 2026-07-08 "classic still has gaps" note was a real redesign bug, now fixed: commit `ada77cf` (2026-07-09, this branch) hardened `document-editor.js`'s `saveDoc` so a 502/503 save response no longer silently marks the doc "Saved" and clears `dirty` (autosave retry was being killed). That was a redesign correctness bug, not a missing capability relative to classic — closed.
5. No remaining classic-only *working* capability was found beyond items 1-2, neither of which is functional.

**Redesign-equivalent status per item:** (1) N/A — already non-functional in classic, nothing to port. (2) covered — redesign's own lazy-loaded module graph is the equivalent. (3) ported — verified via spec + commit history. (4) fixed — was a bug, not a gap. Everything else `/classic` serves is HTML/CSS/JS delivery superseded by the redesign's own bundle.

**Hard blockers for retirement:** none found at the capability level. Steps 2-5 remain deferred solely on the soak-week schedule, not on unresolved parity.

**Soak criteria (gates Steps 2-5):** one full week of `journalctl --user -u openclaw-workspace | grep -c "classic UI served"` returning `0`, starting from when this instrumentation commit deploys. Non-zero at the end of the week means someone/something is still hitting `/classic` — re-investigate before proceeding to Step 2.

- [ ] **Step 2 (safety):** `git tag classic-ui-final` on the last commit shipping it.
- [ ] **Step 3:** In `scripts/sync-frontend.sh`, remove classic modules, `index-classic.html`, legacy `app.js`/`style.css`, and ALL `__tests__/*.test.js` from the sync set (the audit located these globs near `sync-frontend.sh:371-376`; re-locate after the fail-loud refactor). Re-sync; `du -sh frontend/` before/after — expect roughly 3–4× smaller.
- [ ] **Step 4:** Replace the `/classic` route (`app.py` `_spa_html("index-classic.html")` site) with `HTTPException(410)` and a body pointing at `/`. Update its test if one exists; full suite green.
- [ ] **Step 5 (after the soak):** Delete the classic sources from `frontend-vendor/`. This is the step that needs its own detailed plan — write it then, not now.

### Phase F — Test debt (background, one module per idle session)

#### Task 19: Cover the four untested modules

Priority order (by blast radius): `memory.py` (agent memory — data loss class) → `workspace_watch.py` (silent no-op class) → `research_render.py` → `settings_status.py`.

- [ ] **Step 1: `backend/tests/test_memory.py`** — first tests: the two quarantine tests from Task 5 move/extend here, plus overlay/prefs round-trip:

```python
def test_overlay_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(memory, "_OVERLAY", tmp_path / "memory_overlay.json")
    memory._write_json(memory._OVERLAY, {"k": "v"})
    assert memory._read_json(memory._OVERLAY, {}) == {"k": "v"}
```

then behavioral tests for the `USER_SECTION` bullet parsing (`_BULLET` regex) against a fixture markdown body.

- [ ] **Step 2: `test_workspace_watch.py`** — behavior when `watchfiles` is absent (monkeypatch the import to raise `ImportError` → loop exits cleanly + logs once, no crash) and present (a temp-dir write yields an event).
- [ ] **Step 3: `test_research_render.py` + `test_settings_status.py`** — golden-output render test; status endpoint shape test. Commit per module.

---

## Self-review notes

- Every 07-08 finding is either in the "melted" table (verified done) or has a task above; cross-checked item-by-item.
- Tasks 3, 4, 16, 18-step-1 are decision gates for Frank by design — everything mechanical around them is specified.
- Task 12 shortcut URLs and Task 17 upstream hash are explicitly investigation-first steps because the true values live outside this audit's evidence; the investigation commands are given.

## One-line summary

Yesterday the boat had no lifejackets; today it does, and they're proven. What's left: dock the cargo that's already built (one merge), stitch the last two seams (quarantine/schema), put locks on the doors (headers, offline shell), tighten four deck fittings (auto-restart, memory cap, restore drill, deploy guard) — and finally cut loose the 86K-line dead hull still lashed to the side.

---

## Run outcome (2026-07-09) + follow-up register

Executed same-day via subagent-driven development: all tasks complete, merged as `f7091cf`, deployed (suites on merged tree: 959 backend / 207 JS). Final reviews: security CLEAN, architecture READY. Ledger: `.superpowers/sdd/progress.md`.

**Deferred to Frank:**
- **RSVP endpoint is live but headless** — `POST /api/email/rsvp/{uid}` sends a real iCal REPLY to the organizer (gated, injection-safe, tested) with no UI button. Wire an Accept/Decline affordance into the read-view calendar card (whose "Read-only — RSVP in your calendar" copy now understates), or leave API-only deliberately. The per-row `is_invite_candidate` flag ships unused until then.
- **CSP enforce flip** — blocked by 2 inline `<script>` blocks in `frontend-overrides/index.html` (UA sniff + SW registration). Move them to files, soak report-only console for a week, then set `WORKSPACE_CSP_ENFORCE=1`.
- **Classic-UI retirement** — soak clock started at the 2026-07-09 deploy restart. Gate: one week of `journalctl --user -u openclaw-workspace | grep -c "classic UI served"` = 0, then execute Task 18 steps 2–5 under its own plan.
- **Branch cleanup** — `calendar-rsvp` is fully salvaged and safe to delete (original SHAs recorded in the salvage doc); PWA device checks pending: manifest shortcuts (long-press icon) and offline deep-link fallback (devtools offline → navigate anywhere → shell loads).

**Code follow-ups (all reviewed as non-blocking; none gets harder post-deploy):**
- workspace_watch: add one warning log when `watchfiles` is absent (test's caplog-empty assertion is pre-staged to flip).
- settings_status: catch `FileNotFoundError` when the mcporter binary is missing.
- sw.js navigate fallback: try `caches.match(e.request)` before `caches.match('/')`.
- security-headers tests: assert the full CSP string value, not just header presence.
- Once-per-process gate for newer-schema warnings (terminals.read_meta + followup._load).
- Cross-reference comments between the two ics parsers (`backend/calendar_invite.py` ↔ `backend/inbox/calendar_invite.py`); fix `perform_rsvp` docstring ("shared by inbox action branch" — nothing else calls it).
- Manifest "New chat" shortcut lands on the chat surface, not a fresh chat (no chat-new route exists); rename or add the route.
- memory.maybe_auto_extract: widen its except guard to cover the `auto_memory_enabled()` prefs read (contained today — detached task).
