# Perf Audit Remaining Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the remaining fixes from the 2026-06-10 performance audit: deployment/footprint tuning on the 2014 Mac mini (8GB, slow disk), two workspace-frontend cleanups, and gateway source patches for the transcript full-file-read hot paths.

**Architecture:** Three independent layers. Phase 1 is ops-only (launchd plists, shell scripts, brew, cron) — no code. Phase 2–3 touch `openclaw-workspace` (FastAPI backend config + `frontend-overrides/` SPA + `sync-frontend.sh`). Phase 4 patches the OpenClaw gateway TypeScript source at `/Users/admin/openclaw`, builds it, and swaps the compiled `dist/` into the global install.

**Tech Stack:** bash/launchd/plutil, OpenClaw config (`~/.openclaw/openclaw.json`, hot-reloaded), vanilla-JS SPA, TypeScript + pnpm + vitest (gateway).

**Already done (2026-06-10, this session — context for executors):**
- `backend/inbox/sources/slack.py` `kick_refresh()` now async via `asyncio.to_thread`; call site awaited.
- `backend/research.py` prunes finished jobs >24h old on each `/api/research/start`.
- Visibility guards + slower tickers in `frontend-overrides/` (app.js rail-sync/notes badge, js/inbox.js dot, js/chat.js research poll + 250ms tickers); synced to `frontend/`.
- `~/.openclaw/scripts/session-watchdog.sh` prunes `*.archived-*` >30 days.
- `NODE_OPTIONS='--max-old-space-size=512'` added to `~/.openclaw/service-env/ai.openclaw.gateway.env`.

**Pending activation (no action in this plan, just awareness):**
- Workspace backend .py changes need a `ai.openclaw.workspace` restart. ⚠ Restart also activates the 2026-06-08 productization backend (branding env is pinned in the plist, so behavior should be preserved — but verify chat works after).
- Gateway `NODE_OPTIONS` takes effect at the next gateway restart. The nightly 4:00AM codex-log rotation (`ai.openclaw.codex-log-rotate`) restarts the gateway, so it self-activates overnight. Verify with: `ps eww $(pgrep -f 'dist/index.js gateway') | tr ' ' '\n' | grep NODE_OPTIONS`.

**EXECUTION STATUS (2026-06-10, autonomous pass):**
- ✅ Task 1 done (Signal-Desktop 2.1GB deleted — user's manual delete left 2.0GB behind, finished by rm; tmp caches + junk backups cleared, err.log truncated; 11 named config backups kept, total was only 208K so low-value anyway).
- ⚠ Task 2 BLOCKED on sudo: the :8000 server is a deliberate system LaunchDaemon `/Library/LaunchDaemons/local.openclaw.httpserver.plist` (KeepAlive, serves ~/.openclaw/workspace on 0.0.0.0). Needs user decision + sudo; commands in the session summary.
- ✅ Task 3 done (guard plist now `--if-over 150`, guard job reloaded).
- ✅ Task 4 done (CLIProxyAPI stopped via brew services; port 8317 free).
- ✅ Task 5 done (signal-cli wrapper DEFAULT_JVM_OPTS += -Xms32m -Xmx256m; backup kept; activates at next gateway restart).
- ✅ Task 6 done with user sign-off (cortex hourly :00, granola hourly :15, both tz=America/New_York; daily-social-ideas disabled).
- ✅ Task 7 done (Sunday VACUUM of memory/main.sqlite + state_5 size logging inside rotate-codex-logs.sh, while gateway is down; backup kept).
- ✅ Task 8 done (skills.load.watch=false; config parses, hot-reload).
- ✅ Tasks 9–10 done and deployed (commit b4930a5; CACHE_NAME now `gary-<asset-hash>`, deterministic).
- ❌ Tasks 11–13 CANCELLED — not needed: the installed 2026.6.1 (commit 2e08f0f) already migrated `transcriptHasIdempotencyKey`/`findLatestEquivalentAssistantMessageId` to `streamSessionTranscriptLinesReverse` (bounded reverse scan, upstream #54296) and added an mtime-keyed message-count cache in session-utils.fs. The whole-file reads only existed in the stale 2026-04-25 clone the audit read. No build, no gateway restart required.
- Cron diagnosis (added scope): historic errors = stale gpt-5.3-codex slug (already fixed) + timeouts. Live fixes applied: eod-1645 timeoutSeconds 180→600; token-guardrail jq glob `runs/*.jsonl`→`runs/*.jsonl*` (files renamed by cron migration). Reported, not fixed: entity-verify prompt shells out to signal-cli directly (daemon holds the account — rewrite to message tool); AM-brief nested `openclaw` tool failure; midday/control-tower "codex app-server client closed" (environmental).

**Findings checked and REJECTED during planning (do not implement):**
- "Enable SQLite WAL in task registry" — already enabled (`src/tasks/task-registry.store.sqlite.ts:450-452` sets WAL, `synchronous=NORMAL`, `busy_timeout`).
- "Session store cache disabled on chat hot path" — false; `skipCache: true` appears only in tests.
- "uvicorn runs 4 workers" — false; single process (see plist).
- "export menu re-append leak" (`app.js:216`) — no-op after first move; correct as-is.
- "document.js blur/Escape listener cleanup bug" — `_isEditingTabTitle` guard makes it correct.

---

## Phase 1 — Deployment / ops (no code, biggest wins)

### Task 1: Reclaim disk (~2.3 GB)

**Files:**
- Delete: `/Users/admin/.openclaw/workspace/Signal-Desktop/` (2.1 GB)
- Delete: `/Users/admin/.openclaw/openclaw.json.bak*` and similar stale backups
- Empty: `/Users/admin/.openclaw/tmp/node-compile-cache/`, `/Users/admin/.openclaw/tmp/jiti/` (66 MB, regenerate automatically)
- Truncate: `/Users/admin/.openclaw/logs/gateway.err.log` (2.3 MB, frozen since May 26)

- [ ] **Step 1: ASK THE USER before deleting Signal-Desktop.** It is an app bundle inside the content vault — almost certainly a stray copy (the real one would live in /Applications or ~/Library/Application Support/Signal), but confirm:

```bash
ls /Users/admin/.openclaw/workspace/Signal-Desktop | head
du -sh /Users/admin/.openclaw/workspace/Signal-Desktop
```

- [ ] **Step 2: After explicit user confirmation, delete it**

```bash
rm -rf /Users/admin/.openclaw/workspace/Signal-Desktop
```

- [ ] **Step 3: Prune config backups (keep last-good and pre-update)**

```bash
ls -la /Users/admin/.openclaw/openclaw.json.*
# Keep openclaw.json.last-good and openclaw.json.pre-update if present; delete the rest:
cd /Users/admin/.openclaw && ls openclaw.json.* | grep -vE 'last-good|pre-update' | xargs rm -v
```

- [ ] **Step 4: Clear regenerable caches and stale error log**

```bash
rm -rf /Users/admin/.openclaw/tmp/node-compile-cache/* /Users/admin/.openclaw/tmp/jiti/*
: > /Users/admin/.openclaw/logs/gateway.err.log
```

- [ ] **Step 5: Verify**

Run: `du -sh /Users/admin/.openclaw/workspace /Users/admin/.openclaw/tmp`
Expected: workspace ≈1.6G (was 3.7G), tmp ≈ a few MB.

### Task 2: Stray `python -m http.server 8000 --bind 0.0.0.0`

PID 125 at audit time; serves the whole cwd on all interfaces on a LAN-open box. Identify, then kill or re-bind.

- [ ] **Step 1: Identify what launched it and what it serves**

```bash
PID=$(pgrep -f "http.server 8000"); echo pid=$PID
ps -o ppid=,lstart=,command= -p "$PID"
lsof -p "$PID" | grep -m1 cwd
grep -rl "http.server" /Users/admin/Library/LaunchAgents/ 2>/dev/null
grep -n "http.server" /Users/admin/.zshrc /Users/admin/.zprofile 2>/dev/null
```

- [ ] **Step 2: Decide with evidence.** If the cwd contents are something the user clearly serves on purpose, re-bind to loopback (edit whatever launches it: `--bind 127.0.0.1`). If it looks like a forgotten one-off (launched from a shell months ago, serving a random dir), kill it:

```bash
kill "$PID"
```

- [ ] **Step 3: Verify nothing listens on :8000**

Run: `lsof -iTCP:8000 -sTCP:LISTEN`
Expected: no output.

### Task 3: Lower codex-log guard threshold 300 → 150 MB

`logs_2.sqlite` grew 140 MB in ~14h on Jun 9–10; at that rate it can pass 300 MB between nightly rotations. The guard runs every 6h (`StartInterval=21600`); the threshold is the plist's 4th ProgramArgument. Note each triggered rotation restarts the gateway (4–5 min), so don't go below ~150.

**Files:**
- Modify: `/Users/admin/Library/LaunchAgents/ai.openclaw.codex-log-rotate-guard.plist`

- [ ] **Step 1: Edit the threshold argument**

```bash
plutil -replace ProgramArguments.3 -string "150" /Users/admin/Library/LaunchAgents/ai.openclaw.codex-log-rotate-guard.plist
plutil -p /Users/admin/Library/LaunchAgents/ai.openclaw.codex-log-rotate-guard.plist | grep -A6 ProgramArguments
```

Expected: `3 => "150"`.

- [ ] **Step 2: Reload ONLY the guard job (do NOT touch the gateway)**

```bash
launchctl bootout "gui/$(id -u)/ai.openclaw.codex-log-rotate-guard" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" /Users/admin/Library/LaunchAgents/ai.openclaw.codex-log-rotate-guard.plist
launchctl print "gui/$(id -u)/ai.openclaw.codex-log-rotate-guard" | grep -m1 state
```

- [ ] **Step 3: Verify the guard's next run logs the new threshold**

Run (after the next 6h tick, or kickstart the guard once): `tail -5 /Users/admin/.openclaw/logs/codex-log-rotate.log`
Expected: a `guard: NMB < 150MB — skip` (or rotating) line.

### Task 4: Stop CLIProxyAPI (unused, ~40 MB)

Runs via `homebrew.mxcl.cliproxyapi.plist`; memory `project_cliproxyapi` says it's superseded and unused.

- [ ] **Step 1: Stop the service**

```bash
brew services stop cliproxyapi
```

- [ ] **Step 2: Verify port free and process gone**

Run: `lsof -iTCP:8317 -sTCP:LISTEN; pgrep -fl cliproxyapi`
Expected: no output. If the user agrees it's permanently dead, optionally `brew uninstall cliproxyapi`.

### Task 5: Cap the signal-cli JVM heap

The gateway spawns `/Users/admin/signal-cli/bin/signal-cli` (config `channels.signal.cliPath`); the wrapper execs java with no `-Xmx`. JVM default max heap is ~25% of RAM = ~2 GB ceiling on this box.

**Files:**
- Modify: `/Users/admin/signal-cli/bin/signal-cli` (Gradle start script — has a `DEFAULT_JVM_OPTS` variable near the top)

- [ ] **Step 1: Confirm the variable exists and is empty**

```bash
grep -n "DEFAULT_JVM_OPTS" /Users/admin/signal-cli/bin/signal-cli | head -3
```

Expected: a line like `DEFAULT_JVM_OPTS=""` or `DEFAULT_JVM_OPTS='"-Xmx..."'`.

- [ ] **Step 2: Set the heap cap (adjust to match the exact quoting found in Step 1)**

```bash
cp /Users/admin/signal-cli/bin/signal-cli /Users/admin/signal-cli/bin/signal-cli.bak
sed -i '' 's/^DEFAULT_JVM_OPTS=.*/DEFAULT_JVM_OPTS='"'"'"-Xms32m" "-Xmx256m"'"'"'/' /Users/admin/signal-cli/bin/signal-cli
grep -n "DEFAULT_JVM_OPTS" /Users/admin/signal-cli/bin/signal-cli | head -1
```

(If the script format differs, hand-edit so the java invocation receives `-Xms32m -Xmx256m`. A signal-cli upgrade replaces this wrapper — re-apply after upgrades.)

- [ ] **Step 3: Activates at next gateway restart (tonight's rotation). Verify afterwards**

Run: `ps axo command | grep -m1 "org.asamk.signal" | grep -o "Xmx[0-9]*m"`
Expected: `Xmx256m`.

### Task 6: Reduce cron refresh frequency (with user sign-off)

~70 cron invocations/day. Top offenders: Slack refresh (every 30 min, 8AM–7PM), Granola sync + Cortex ingest (each every 30 min, 9AM–5PM). **Ask the user which cadences they accept**, then edit via the OpenClaw CLI (don't hand-edit `~/.openclaw/cron/jobs.json.migrated` — the gateway owns that state).

- [ ] **Step 1: List jobs and capture ids**

```bash
/Users/admin/.nvm/versions/node/v22.22.0/bin/openclaw cron list
```

- [ ] **Step 2: Propose to user: Slack 30→60 min, Granola 30→60 min, Cortex 30→60 min** (saves ~30 runs/day and a large share of daily token burn). Apply each approved change:

```bash
/Users/admin/.nvm/versions/node/v22.22.0/bin/openclaw cron edit <job-id> --schedule "0 * 8-18 * * 1-5"   # check `openclaw cron edit --help` for exact flag names first
```

- [ ] **Step 3: Verify**

Run: `/Users/admin/.nvm/versions/node/v22.22.0/bin/openclaw cron list`
Expected: edited jobs show the new schedules; watch the next day's token-guardrail report drop.

### Task 7: SQLite maintenance for the unrotated DBs

`memory/main.sqlite` (96 MB) and codex `state_5.sqlite` (96 MB) have no pruning. Piggy-back on the nightly rotation script, which already stops the gateway (safe window for VACUUM).

**Files:**
- Modify: `/Users/admin/.openclaw/bin/rotate-codex-logs.sh`

- [ ] **Step 1: Find the spot in the script after the gateway bootout/wait and before the bootstrap** (read the script; the structure is: bootout → wait loop → delete logs_2.sqlite\* → bootstrap).

- [ ] **Step 2: Insert before the bootstrap step:**

```bash
# Weekly-ish maintenance while the gateway is down: compact the memory DB and
# log state_5 size so growth is visible. Only on Sundays to bound added downtime.
if [ "$(date +%u)" = "7" ]; then
  log "vacuum memory/main.sqlite ($(stat -f%z "$HOME/.openclaw/memory/main.sqlite" 2>/dev/null || echo 0)B before)"
  /usr/bin/sqlite3 "$HOME/.openclaw/memory/main.sqlite" "VACUUM;" 2>>"$LOG" || log "WARN memory vacuum failed"
  log "vacuum done ($(stat -f%z "$HOME/.openclaw/memory/main.sqlite" 2>/dev/null || echo 0)B after)"
fi
log "state_5.sqlite size: $(stat -f%z "$CH/state_5.sqlite" 2>/dev/null || echo 0)B"
```

- [ ] **Step 3: Syntax-check and verify next Sunday's log**

Run: `bash -n /Users/admin/.openclaw/bin/rotate-codex-logs.sh && echo OK`
Expected: `OK`. After the next Sunday 4AM run: `grep vacuum /Users/admin/.openclaw/logs/codex-log-rotate.log | tail -3` shows before/after sizes.

---

## Phase 2 — Gateway config knob

### Task 8: Disable the skills file-watcher

`src/agents/skills/refresh.ts:100` reads `config.skills.load.watch !== false` — setting it false skips the chokidar watcher entirely. Config hot-reloads (no gateway restart). Tradeoff: after editing a SKILL.md you must reload manually (config touch or restart).

**Files:**
- Modify: `/Users/admin/.openclaw/openclaw.json`

- [ ] **Step 1: Back up, then set the knob**

```bash
cp /Users/admin/.openclaw/openclaw.json /Users/admin/.openclaw/openclaw.json.pre-skillswatch
python3 - <<'EOF'
import json
p = '/Users/admin/.openclaw/openclaw.json'
cfg = json.load(open(p))
cfg.setdefault('skills', {}).setdefault('load', {})['watch'] = False
json.dump(cfg, open(p, 'w'), indent=2)
print('skills.load.watch =', cfg['skills']['load']['watch'])
EOF
```

- [ ] **Step 2: Verify hot-reload accepted it**

Run: `sleep 5; tail -20 /Users/admin/.openclaw/logs/config-audit.jsonl`
Expected: a recent reload entry, no error. Chat still works (send a ping via the workspace UI).

---

## Phase 3 — Workspace frontend

Both tasks end with `./scripts/sync-frontend.sh` — that IS the deploy. There is no JS test infra; verification is syntax-check plus a browser smoke. Repo has uncommitted work from other sessions: commit only the files you touched.

### Task 9: Merge the dual `#chat-history` scroll listeners

**Files:**
- Modify: `/Users/admin/openclaw-workspace/frontend-overrides/app.js:144-154`

- [ ] **Step 1: Replace both listeners with one** (popup cleanup stays immediate per the original intent, but early-exits with a single `querySelector` instead of two unconditional `querySelectorAll`s; the auto-scroll check stays debounced):

```js
  // Scrolling — one listener: immediate popup dismissal (cheap early-exit),
  // debounced auto-scroll tracking.
  const _autoScrollCheck = uiModule.debounce(() => {
    const box = el('chat-history');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    uiModule.setAutoScroll(atBottom);
  }, 100);
  el('chat-history').addEventListener('scroll', () => {
    if (document.querySelector('.ctx-popup, .memory-used-detail, .msg-overflow-menu')) {
      document.querySelectorAll('.ctx-popup, .memory-used-detail, .msg-overflow-menu').forEach(p => p.remove());
      document.querySelectorAll('.memory-used-pill').forEach(p => { p._openDetail = null; });
    }
    _autoScrollCheck();
  }, { passive: true });
```

This replaces the block currently at lines 144–154 (the `addEventListener('scroll', uiModule.debounce(...))` call AND the second `addEventListener('scroll', ...)` popup-removal call). Don't touch the `wheel`/`touchmove` listeners below it.

- [ ] **Step 2: Syntax check**

Run: `cd /Users/admin/openclaw-workspace && node --input-type=module --check < frontend-overrides/app.js && echo OK`
Expected: `OK`

- [ ] **Step 3: Deploy and smoke**

Run: `./scripts/sync-frontend.sh`
Browser: open the workspace, open a chat, click a memory pill so its popup shows, scroll — popup must vanish; scroll to bottom — auto-scroll resumes (new streamed text sticks to bottom).

- [ ] **Step 4: Commit (only your file)**

```bash
git add frontend-overrides/app.js && git commit -m "perf: merge chat-history scroll listeners, early-exit popup cleanup"
```

### Task 10: Auto-version the service-worker cache in sync-frontend.sh

`CACHE_NAME` in `frontend-vendor/sw.js` (currently `'gary-v327'`) is hand-bumped; a forgotten bump ships stale precached assets (see memory `feedback_esm_version_query_double_load`). Bake a content hash at sync time so `frontend/sw.js` self-versions; the vendored source keeps the human-readable name.

**Files:**
- Modify: `/Users/admin/openclaw-workspace/scripts/sync-frontend.sh` (append before the SerpAPI section or at end)

- [ ] **Step 1: Append to sync-frontend.sh:**

```bash
# --- Auto-version the service worker cache ------------------------------------
# CACHE_NAME must change whenever any served asset changes, or clients can keep
# precached stale files. Hash all built assets (except sw.js itself) and bake
# the digest into the deployed sw.js. The vendored sw.js keeps its base name.
SW="$DEST/sw.js"
if [[ -f "$SW" ]]; then
  ASSET_HASH=$(find "$DEST" -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.webmanifest' \) ! -name 'sw.js' -print0 \
    | sort -z | xargs -0 cat | md5 -q | cut -c1-10)
  sedi "s/^const CACHE_NAME = .*/const CACHE_NAME = 'gary-${ASSET_HASH}';/" "$SW"
  echo "stamped sw.js CACHE_NAME = gary-${ASSET_HASH}"
fi
```

- [ ] **Step 2: Run sync twice; verify deterministic and correct**

Run: `./scripts/sync-frontend.sh | tail -2 && grep "^const CACHE_NAME" frontend/sw.js && ./scripts/sync-frontend.sh >/dev/null && grep "^const CACHE_NAME" frontend/sw.js`
Expected: same hash both runs; changes only when an asset changes.

- [ ] **Step 3: Browser smoke** — hard-reload the workspace once; in devtools → Application → Cache Storage, old `gary-v327` cache is dropped after the new SW activates.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-frontend.sh && git commit -m "build: auto-version sw.js CACHE_NAME from asset hash at sync"
```

---

## Phase 4 — Gateway source patches (transcript hot paths)

The gateway re-reads the ENTIRE session transcript per message for the idempotency check and the delivery-mirror dedup scan (`src/config/sessions/transcript.ts:231-261` and `:286-329`). The session-watchdog caps active transcripts at 5 MB, so today's worst case is two 5 MB read+parse passes per message on a spinning disk — real but bounded. Patch both to tail-reads. `readSessionMessages` (`src/gateway/session-utils.fs.ts:105`) also full-reads but feeds history fetches (bounded by the same 5 MB cap and a 6 MB downstream limit) — leave it unless profiling says otherwise (YAGNI).

**Worth doing as an upstream PR** — then the local build/deploy dance disappears on the next release.

### Task 11: Build-from-source pipeline (one-time prep)

**Files:**
- Work in: `/Users/admin/openclaw` (clone is at 8462218a69, 2026-04-25; installed version is 2026.6.1)

- [ ] **Step 1: Sync the clone to the installed version**

```bash
cd /Users/admin/openclaw && git fetch origin --tags && git status --short
# expect clean; then:
git checkout v2026.6.1 -b perf/transcript-tail-reads 2>/dev/null || git checkout -b perf/transcript-tail-reads $(git tag --list | grep 2026.6.1)
```

(If no such tag exists, find it: `git tag --list | tail -20`. Patch on top of whatever matches the installed `OPENCLAW_SERVICE_VERSION='2026.6.1'`.)

- [ ] **Step 2: Install deps and prove the build + tests run on this machine** (slow box: expect many minutes; run once, in the background if needed)

```bash
pnpm install && pnpm build && pnpm vitest run src/config/sessions --reporter=dot
```

Expected: build succeeds, session tests green BEFORE any patch. If this fails, stop — fix the toolchain first.

### Task 12: Tail-read the two transcript scans (TDD)

**Files:**
- Modify: `/Users/admin/openclaw/src/config/sessions/transcript.ts:231-329`
- Test: add to the existing test file that covers transcript writes (locate with `grep -rl "transcriptHasIdempotencyKey\|appendTranscriptMessage" src/config/sessions/*.test.ts` — if the functions are unexported/untested, add `src/config/sessions/transcript.tail.test.ts` and export the helper).

- [ ] **Step 1: Write the failing test** (new file `src/config/sessions/transcript.tail.test.ts`):

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTranscriptTailLines } from "./transcript";

describe("readTranscriptTailLines", () => {
  it("returns only complete lines from the tail window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-tail-"));
    const file = path.join(dir, "t.jsonl");
    const lines = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ id: `m${i}`, message: { idempotencyKey: `k${i}` } }),
    );
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const tail = await readTranscriptTailLines(file, 64 * 1024);
    // Window smaller than file: must not include the first line,
    // must include the last, and every entry must be parseable (no torn line).
    expect(tail[tail.length - 1]).toBe(lines[lines.length - 1]);
    expect(tail).not.toContain(lines[0]);
    for (const line of tail) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("returns the whole file when smaller than the window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-tail-"));
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, '{"id":"a"}\n{"id":"b"}\n');
    const tail = await readTranscriptTailLines(file, 64 * 1024);
    expect(tail).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/config/sessions/transcript.tail.test.ts`
Expected: FAIL — `readTranscriptTailLines` is not exported.

- [ ] **Step 3: Implement the helper in `transcript.ts`** (above `transcriptHasIdempotencyKey`):

```typescript
/**
 * Read only the last `maxBytes` of a JSONL transcript and return complete
 * lines. Bounds per-message dedup scans on large transcripts: both callers
 * only care about recent entries (idempotency keys are retry-window-scoped;
 * the delivery-mirror scan walks backward and stops at the first assistant
 * message). 1 MiB default covers thousands of messages.
 */
export async function readTranscriptTailLines(
  transcriptPath: string,
  maxBytes = 1024 * 1024,
): Promise<string[]> {
  const handle = await fs.promises.open(transcriptPath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf-8");
    if (start > 0) {
      // Drop the first (possibly torn) line.
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  } finally {
    await handle.close();
  }
}
```

- [ ] **Step 4: Run the new test — expect PASS**

Run: `pnpm vitest run src/config/sessions/transcript.tail.test.ts`

- [ ] **Step 5: Switch both scanners to the helper.** In `transcriptHasIdempotencyKey` replace:

```typescript
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
```

with:

```typescript
    const lines = await readTranscriptTailLines(transcriptPath);
    for (const line of lines) {
```

(keep the try/catch and the rest of the loop body; the `!line.trim()` guard is now redundant but harmless to drop since the helper filters blanks). In `findLatestEquivalentAssistantMessageId` replace:

```typescript
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    const lines = raw.split(/\r?\n/);
```

with:

```typescript
    const lines = await readTranscriptTailLines(transcriptPath);
```

(the backward loop and its `!line.trim()` check keep working unchanged). Wrap each call in the same existing try/catch — `readTranscriptTailLines` throws on missing file, which the existing `catch { return undefined; }` already handles.

- [ ] **Step 6: Run the full sessions test suite**

Run: `pnpm vitest run src/config/sessions`
Expected: all green. The behavior change (keys older than the 1 MiB tail no longer dedupe) is intended; if a test asserts whole-file dedup, raise it for review rather than silently changing the test.

- [ ] **Step 7: Build and commit**

```bash
pnpm build
git add src/config/sessions/transcript.ts src/config/sessions/transcript.tail.test.ts
git commit -m "perf: bound transcript dedup scans to a 1MiB tail window"
```

### Task 13: Deploy the patched gateway

⚠ Gateway restart costs 4–5 min on this box (memory `openclaw-hardware-constraint`): restart ONCE, then wait. Best done right before the nightly 4AM rotation, or let the rotation itself do the restart.

- [ ] **Step 1: Back up the installed dist**

```bash
GLOBAL=/Users/admin/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw
cp -R "$GLOBAL/dist" "$GLOBAL/dist.bak-pre-tailread"
```

- [ ] **Step 2: Copy the built dist over the global install**

```bash
rsync -a --delete /Users/admin/openclaw/dist/ "$GLOBAL/dist/"
```

- [ ] **Step 3: Restart the gateway once and wait for SERVING (not just port-bind)**

```bash
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"
# poll up to ~6 min:
for i in $(seq 1 36); do curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18789/v1/models && break; sleep 10; done
```

- [ ] **Step 4: Smoke: send a chat turn via the workspace UI; send a Signal DM. Both must round-trip. On any regression, restore:**

```bash
rsync -a --delete "$GLOBAL/dist.bak-pre-tailread/" "$GLOBAL/dist/" && launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"
```

- [ ] **Step 5: Offer the patch upstream** — `gh pr create` from the branch against `github.com/openclaw/openclaw` so future updates carry it.

---

## Execution order & safety notes

1. Phase 1 Tasks 2–5 and 7 are independent and safe any time. Task 1 (Signal-Desktop) and Task 6 (cron cadence) need user confirmation first.
2. Phase 2 Task 8 is hot-reloaded, zero restart.
3. Phase 3 deploys instantly via sync (static files served from disk); no backend restart.
4. Phase 4 is the only gateway-restart item. Bundle it with any pending workspace-backend restart so the box thrashes once, not twice.
5. The repo has other sessions' uncommitted changes — `git add` specific files only, never `git add -A`.
