# Mobile PWA Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the inert service worker, cut mobile wire weight ~5×, and repair the verified mobile glitches (keyboard, safe-area, pull-to-refresh, resume, touch targets) from the 2026-06-12 mobile review.

**Architecture:** Backend gets two surgical additions (a `/sw.js` scope-fixing route + GZipMiddleware, plus two tiny config/TTL tweaks). All frontend work lands in `frontend-overrides/` (or `frontend-vendor/` for the few vendor-only files — upstream is dead, vendor edits are durable per project convention), with CSS strictly in append-only blocks so the concurrent session's uncommitted work merges cleanly. `scripts/sync-frontend.sh` learns to generate the SW precache list.

**Tech Stack:** FastAPI/Starlette, vanilla ES modules, pytest, bash. NO headless-browser verification on this box — `node --check` + curl + pytest only.

**Branch/worktree:** `.worktrees/mobile-pwa-polish` (branch `mobile-pwa-polish` off ba10db2). Spec: `docs/superpowers/specs/2026-06-12-mobile-pwa-polish-design.md`.

**Baseline:** 309/310 pytest green. `test_documents_export.py::test_export_docx_roundtrip` fails with a 500 in this shell (pandoc/PATH environment quirk, pre-existing — not ours, don't fix, don't break further).

**Hard constraints for every task:**
- Do NOT touch: the `{type:"metrics"}` code in backend/app.py chat_stream, send-button/attach/text-size areas of hermes.css/index.html/theme.js/app.js/fileHandler.js — a concurrent session owns those (its work is uncommitted in the MAIN checkout; you are in the worktree and won't see it — just stay out of those regions).
- CSS changes: append new blocks at END of file (or end of the relevant section) — never rewrite existing rules unless the task says so.
- Frontend JS verification = `node --check <file>` after every edit.
- Anchors below are code snippets to grep for, not line numbers (line numbers drift).

---

### Task 1: Backend — `/sw.js` scope route + gzip compression

**Files:**
- Modify: `backend/app.py`
- Test: `backend/tests/test_static_serving.py` (create)

- [ ] **Step 1: Write the failing tests**

```python
"""Tests for /sw.js scope route and gzip middleware."""
from pathlib import Path

from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config


def test_sw_route_serves_worker(monkeypatch, tmp_path: Path):
    (tmp_path / "sw.js").write_text("const CACHE_NAME = 'test';\n")
    monkeypatch.setattr(config, "FRONTEND_DIR", tmp_path)
    client = TestClient(app_module.app)
    res = client.get("/sw.js")
    assert res.status_code == 200
    assert "javascript" in res.headers["content-type"]
    # Must never be cached hard: the SW file is the update mechanism itself.
    assert "no-cache" in res.headers.get("cache-control", "")
    assert "CACHE_NAME" in res.text


def test_sw_route_404_when_missing(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(config, "FRONTEND_DIR", tmp_path / "nope")
    client = TestClient(app_module.app)
    assert client.get("/sw.js").status_code == 404


def test_gzip_middleware_registered():
    from starlette.middleware.gzip import GZipMiddleware
    assert any(m.cls is GZipMiddleware for m in app_module.app.user_middleware)


def test_gzip_compresses_large_json(monkeypatch):
    # Any >1KB response should come back gzipped when the client asks.
    big = {"items": [{"i": i, "pad": "x" * 64} for i in range(64)]}

    async def fake_models():
        return big
    # /api/config is tiny; use a known JSON route by patching its handler is
    # brittle — instead hit /api/auth/settings after seeding a big settings file.
    from backend import websearch
    monkeypatch.setattr(websearch, "load_settings", lambda: big)
    client = TestClient(app_module.app)
    res = client.get("/api/auth/settings", headers={"accept-encoding": "gzip"})
    assert res.status_code == 200
    assert res.headers.get("content-encoding") == "gzip"
```

NOTE for the implementer: check how `/api/auth/settings` builds its payload
(`grep -n "auth/settings" backend/app.py`) and patch whatever function feeds it
so the body is >1024 bytes; the shape above is illustrative — adjust the
monkeypatch target to the real one, keep the assertion. TestClient must send
`accept-encoding: gzip` explicitly.

- [ ] **Step 2: Run tests, verify they fail**

Run: `../../.venv/bin/python -m pytest backend/tests/test_static_serving.py -q`
Expected: 4 failures (404 route missing, middleware missing).

- [ ] **Step 3: Implement**

In `backend/app.py`, right after `app = FastAPI(...)` (anchor: `app = FastAPI(title="OpenClaw Workspace"`):

```python
from starlette.middleware.gzip import GZipMiddleware

# Wire bytes matter on the phone-over-Tailscale path and nothing upstream
# compresses (Tailscale Serve passes bytes through): style.css alone is 1MB
# raw / 227KB gzipped. Streaming responses (SSE) are flushed per-chunk by
# Starlette's GZipResponder, so /api/chat/stream keeps streaming.
app.add_middleware(GZipMiddleware, minimum_size=1024)
```

Near the static mount block (anchor: `# --- Serve the reused Odysseus SPA`),
ABOVE the `if config.FRONTEND_DIR.exists():` block, add an unconditional route:

```python
@app.get("/sw.js")
async def service_worker():
    """Serve the service worker from the ORIGIN ROOT.

    Registered at /static/sw.js the SW's max scope is /static/ and it can
    never control the SPA at / — the whole offline story was inert (2026-06-12
    mobile review, P0). Served at /sw.js its default scope is the origin root.
    no-cache so browsers revalidate the worker itself on each check.
    """
    sw = config.FRONTEND_DIR / "sw.js"
    if not sw.exists():
        return JSONResponse(status_code=404, content={"error": "sw.js not built"})
    return FileResponse(str(sw), media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})
```

- [ ] **Step 4: Run tests, verify pass**

Run: `../../.venv/bin/python -m pytest backend/tests/test_static_serving.py backend/tests/test_chat_stream*.py -q`
(also run the existing SSE/chat-stream tests — httpx sends gzip accept by
default, so they now exercise the gzip path; all must stay green)

- [ ] **Step 5: Commit**

```bash
git add backend/app.py backend/tests/test_static_serving.py
git commit -m "fix(pwa): serve sw.js at origin root (scope bug made SW inert) + gzip middleware"
```

---

### Task 2: index.html — register /sw.js, drop ?v= double-loads, real apple-touch-icon

**Files:**
- Modify: `frontend-overrides/index.html`

- [ ] **Step 1: Fix the SW registration** (anchor: `navigator.serviceWorker.register('/static/sw.js')`):

```html
<script nonce="{{CSP_NONCE}}">if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}</script>
```

- [ ] **Step 2: Drop the `?v=` queries** (they create second ES-module instances — chat.js's body MutationObserver attaches twice; see feedback_esm_version_query_double_load):

Anchor `src="/static/js/chat.js?v=` → `src="/static/js/chat.js"`.
Anchor `src="/static/app.js?v=` → `src="/static/app.js"` AND rewrite that line's trailing comment to: `<!-- app.js must be LAST; cache-bust via CACHE_NAME (sync-frontend.sh stamps it) — NEVER ?v= a module (double-instance bug) -->`

Then verify no module tag carries a query: `grep -n 'type="module" src=.*?v=' frontend-overrides/index.html` → no output.

- [ ] **Step 3: Point apple-touch-icon at the 180×180 file** (anchor: `rel="apple-touch-icon"`):

```html
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
```

- [ ] **Step 4: Verify + commit**

`grep -c 'register(.\/sw.js' frontend-overrides/index.html` → 1.

```bash
git add frontend-overrides/index.html
git commit -m "fix(pwa): register SW at origin scope; drop ?v= module double-loads; 180px touch icon"
```

---

### Task 3: Service worker — generated precache, offline timeout race; sync-script hygiene

**Files:**
- Modify: `frontend-vendor/sw.js`
- Modify: `scripts/sync-frontend.sh` (the KEEP-LAST cache-version block)

- [ ] **Step 1: Replace the hand-maintained PRECACHE in `frontend-vendor/sw.js`**

Replace the entire `const PRECACHE = [ ... ];` array (anchors: starts `const PRECACHE = [`, ends `];` after `/static/lib/highlight.min.js`) with:

```js
// Generated at deploy time by scripts/sync-frontend.sh from the files
// actually present in frontend/ (the hand-maintained list rotted: it missed
// the whole workspace overlay layer and still listed removed files).
const PRECACHE = [
  '/',
  /*__PRECACHE__*/
];
```

- [ ] **Step 2: Add the offline timeout race to the JS/CSS and navigation paths**

At the top of the fetch section (after `const CACHE_NAME` usage, before the listeners), add:

```js
// On a half-dead link (cellular drop, tailnet relay blackhole) a plain
// fetch() hangs for the full OS TCP timeout before the cache fallback runs.
// Race it: network wins whenever it actually answers, cache wins after ~4s.
function networkWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sw-timeout')), ms || 4000);
    fetch(req).then(res => { clearTimeout(t); resolve(res); },
                    err => { clearTimeout(t); reject(err); });
  });
}
```

In the JS/CSS network-first branch (anchor: `// JS/CSS: network-first`), change `fetch(e.request).then(res => {` to:

```js
      networkWithTimeout(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || fetch(e.request)))
```

(the final `|| fetch(e.request)` keeps cache-miss behavior identical to today:
wait for the real network rather than erroring at 4s.)

In the navigation branch (anchor: `const network = fetch(e.request).then`), change `fetch(e.request)` to `networkWithTimeout(e.request, 4000)` — its `.catch(() => cached)` already handles the fallback, and `return cached || network;` keeps cache-first-when-present semantics.

Bump nothing manually — CACHE_NAME is stamped by the sync script.

- [ ] **Step 3: Teach sync-frontend.sh to emit the precache list, hash manifest.json, and hash portably**

In the final block of `scripts/sync-frontend.sh` (anchor: `# --- Auto-version the service worker cache`), replace the block body with:

```bash
SW="$DEST/sw.js"
if [[ -f "$SW" ]]; then
  # Generate the precache manifest from what's actually deployed (sw.js holds
  # a /*__PRECACHE__*/ token). Keep it to the shell the app needs offline:
  # all JS/CSS, fonts, icons, manifest. Exclude sw.js itself and source maps.
  PRECACHE_LIST=$(cd "$DEST" && find . -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.woff2' -o -name '*.png' \
         -o -name '*.svg' -o -name 'manifest.json' \) \
      ! -name 'sw.js' ! -name '*.map' \
    | sort | sed "s|^\./|'/static/|; s|$|',|" | tr '\n' ' ')
  python3 - "$SW" "$PRECACHE_LIST" <<'PYEOF'
import sys
sw_path, entries = sys.argv[1], sys.argv[2]
src = open(sw_path).read()
src = src.replace("/*__PRECACHE__*/", entries.rstrip())
open(sw_path, "w").write(src)
PYEOF
  echo "injected $(echo "$PRECACHE_LIST" | tr ',' '\n' | grep -c static) precache entries into sw.js"

  # Portable content hash (md5 is macOS-only; md5sum is Linux/CI).
  hash_cmd() { if command -v md5 >/dev/null 2>&1; then md5 -q; else md5sum | cut -d' ' -f1; fi; }
  ASSET_HASH=$(find "$DEST" -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.webmanifest' -o -name 'manifest.json' \) ! -name 'sw.js' -print0 \
    | sort -z | xargs -0 cat | hash_cmd | cut -c1-10)
  sedi "s/^const CACHE_NAME = .*/const CACHE_NAME = 'gary-${ASSET_HASH}';/" "$SW"
  echo "stamped sw.js CACHE_NAME = gary-${ASSET_HASH}"
fi
```

CAREFUL: the token replacement must run BEFORE the hash (the hash excludes
sw.js, so order only matters for correctness of the echo; keep it as shown).
The `sed "s|^\./|'/static/|"` produces entries like `'/static/js/chat.js',`.

- [ ] **Step 4: Verify with a scratch build**

```bash
WORKSPACE_BUILD_DEST=/tmp/pwa-sync-test bash scripts/sync-frontend.sh
grep -c "'/static/" /tmp/pwa-sync-test/sw.js          # expect: >60
grep -n "__PRECACHE__" /tmp/pwa-sync-test/sw.js       # expect: no output
grep -n "hermes.css\|workspace.css\|hermes-panels" /tmp/pwa-sync-test/sw.js | head -3   # expect: present
node --check /tmp/pwa-sync-test/sw.js                  # expect: clean
grep -n "const CACHE_NAME" /tmp/pwa-sync-test/sw.js    # expect: gary-<10 hex>
rm -rf /tmp/pwa-sync-test
```

(If `WORKSPACE_BUILD_DEST` isn't the env var the script uses, check its header
— memory says it exists from the productization work; adapt.)

- [ ] **Step 5: Commit**

```bash
git add frontend-vendor/sw.js scripts/sync-frontend.sh
git commit -m "fix(pwa): generate SW precache at sync time; 4s offline race; portable hash incl. manifest.json"
```

---

### Task 4: Lazy-load mermaid (drop ~905KB gz from every boot)

**Files:**
- Modify: `frontend-overrides/index.html` (head script block)
- Modify: `frontend-overrides/js/chat.js` (one call site)

- [ ] **Step 1: Replace the eager mermaid tag with an on-demand loader**

In `frontend-overrides/index.html`, anchor block:

```html
  <script id="mermaid-script" async src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
```

Delete that line. In the `<script nonce="{{CSP_NONCE}}">` block right below it
(anchor: `var m = document.getElementById('mermaid-script');`), replace the
mermaid half (keep the katex-css part!) with:

```js
      // Mermaid is ~905KB gzipped / ~2.8MB parsed — load it only when a
      // diagram actually needs rendering (chat.js calls window.ensureMermaid).
      // Pinned version: @11 range-alias re-downloads on short CDN max-age.
      var _mermaidLoading = false;
      window.ensureMermaid = function () {
        if (window.mermaid || _mermaidLoading) return;
        _mermaidLoading = true;
        var s = document.createElement('script');
        s.id = 'mermaid-script';
        s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11.6.0/dist/mermaid.min.js';
        s.async = true;
        s.addEventListener('load', function () {
          if (window.odysseusInitMermaid) window.odysseusInitMermaid();
          // Render any diagrams that arrived while the lib was loading.
          var pending = document.querySelectorAll('pre.mermaid:not([data-processed])');
          if (pending.length && window.mermaid) {
            try { window.mermaid.run({ nodes: pending }); } catch (e) {}
          }
        }, { once: true });
        document.head.appendChild(s);
      };
```

(Check the current mermaid@11 exact version with `curl -sI https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js | grep -i location` or default to 11.6.0.)

- [ ] **Step 2: Trigger the loader from chat.js**

Anchor in `frontend-overrides/js/chat.js`:

```js
        if (markdownModule.renderMermaid) markdownModule.renderMermaid(roundHolder);
```

Replace with:

```js
        if (markdownModule.renderMermaid) {
          // Lazy mermaid: the lib is no longer loaded at boot. renderMermaid
          // no-ops without window.mermaid; kick the loader when a diagram is
          // actually present (its load handler renders pending nodes).
          if (!window.mermaid && window.ensureMermaid && roundHolder.querySelector('pre.mermaid')) {
            window.ensureMermaid();
          }
          markdownModule.renderMermaid(roundHolder);
        }
```

Check for other `renderMermaid(` call sites (`grep -rn "renderMermaid(" frontend-overrides/ frontend-vendor/js/chat*.js frontend-vendor/js/chatRenderer.js`) and give any other live call site the same guard. (KaTeX stays eager — small payload, and markdown.js renders math inline-on-parse; lazy-loading it would silently skip math in already-rendered history.)

- [ ] **Step 3: Verify + commit**

`node --check frontend-overrides/js/chat.js` → clean. `grep -c "ensureMermaid" frontend-overrides/index.html frontend-overrides/js/chat.js` → ≥1 each.

```bash
git add frontend-overrides/index.html frontend-overrides/js/chat.js
git commit -m "perf(mobile): lazy-load mermaid on first diagram (drops ~905KB gz from boot)"
```

---

### Task 5: modulepreload the real import graph

**Files:**
- Modify: `frontend-overrides/index.html` (anchor: the existing 5 `<link rel="modulepreload"` lines)

- [ ] **Step 1: Replace the 5 modulepreload lines with the verified static-import graph**

The graph below was extracted from `^import` lines of app.js + js/chat.js (overrides) and js/sessions.js + vendor ui.js. Before pasting, RE-VERIFY each file exists (`for f in ...; do [ -f frontend-vendor/$f ] || [ -f frontend-overrides/$f ] || echo MISSING $f; done` — adjust paths js/→) and that nothing was missed: `grep -h "^import" frontend-overrides/app.js frontend-overrides/js/chat.js frontend-overrides/js/sessions.js frontend-vendor/js/ui.js frontend-vendor/js/emailInbox.js | grep -o "from '[^']*'" | sort -u`.

```html
  <link rel="modulepreload" href="/static/app.js">
  <!-- Full static-import graph: without these, the second tier is only
       discovered after app.js (172KB) downloads+parses — 2-3 extra RTT waves
       on the phone-over-Tailscale path. Keep in sync with the import lists of
       app.js / js/chat.js (this is the eager graph; lazy imports excluded). -->
  <link rel="modulepreload" href="/static/js/chat.js">
  <link rel="modulepreload" href="/static/js/ui.js">
  <link rel="modulepreload" href="/static/js/sessions.js">
  <link rel="modulepreload" href="/static/js/markdown.js">
  <link rel="modulepreload" href="/static/js/storage.js">
  <link rel="modulepreload" href="/static/js/theme.js">
  <link rel="modulepreload" href="/static/js/spinner.js">
  <link rel="modulepreload" href="/static/js/memory.js">
  <link rel="modulepreload" href="/static/js/models.js">
  <link rel="modulepreload" href="/static/js/rag.js">
  <link rel="modulepreload" href="/static/js/presets.js">
  <link rel="modulepreload" href="/static/js/search.js">
  <link rel="modulepreload" href="/static/js/tts-ai.js">
  <link rel="modulepreload" href="/static/js/document.js">
  <link rel="modulepreload" href="/static/js/gallery.js">
  <link rel="modulepreload" href="/static/js/group.js">
  <link rel="modulepreload" href="/static/js/notes.js">
  <link rel="modulepreload" href="/static/js/tasks.js">
  <link rel="modulepreload" href="/static/js/calendar.js">
  <link rel="modulepreload" href="/static/js/admin.js">
  <link rel="modulepreload" href="/static/js/censor.js">
  <link rel="modulepreload" href="/static/js/settings.js">
  <link rel="modulepreload" href="/static/js/keyboard-shortcuts.js">
  <link rel="modulepreload" href="/static/js/sidebar-layout.js">
  <link rel="modulepreload" href="/static/js/section-management.js">
  <link rel="modulepreload" href="/static/js/search-chat.js">
  <link rel="modulepreload" href="/static/js/cookbook.js">
  <link rel="modulepreload" href="/static/js/compare/index.js">
  <link rel="modulepreload" href="/static/js/fileHandler.js">
  <link rel="modulepreload" href="/static/js/voiceRecorder.js">
  <link rel="modulepreload" href="/static/js/chatRenderer.js">
  <link rel="modulepreload" href="/static/js/chatStream.js">
  <link rel="modulepreload" href="/static/js/codeRunner.js">
  <link rel="modulepreload" href="/static/js/emailInbox.js">
  <link rel="modulepreload" href="/static/js/research/panel.js">
  <link rel="modulepreload" href="/static/js/researchSynapse.js">
  <link rel="modulepreload" href="/static/js/slashCommands.js">
  <link rel="modulepreload" href="/static/js/modalManager.js">
  <link rel="modulepreload" href="/static/js/modelPicker.js">
  <link rel="modulepreload" href="/static/js/providers.js">
```

If emailInbox.js statically imports `emailLibrary/*` add those too (check the grep).

- [ ] **Step 2: Commit**

```bash
git add frontend-overrides/index.html
git commit -m "perf(mobile): modulepreload the full static-import graph (kills 2-3 RTT discovery waves)"
```

---

### Task 6: CSS — composer safe-area, temporal-input zoom guard, scrollable tables

**Files:**
- Modify: `frontend-overrides/hermes.css` (APPEND at end of file only)
- Modify: `frontend-overrides/workspace.css`

- [ ] **Step 1: Append to END of `frontend-overrides/hermes.css`:**

```css
/* ── Mobile safe-area: capsule composer (2026-06-12 mobile review C1) ──
   The capsule rule's `padding` SHORTHAND above wipes style.css's mobile
   `padding-bottom: calc(10px + env(safe-area-inset-bottom))` (equal
   specificity, this sheet loads later) — so the bottom control row sat in
   the home-indicator gesture zone in the standalone PWA. Append-only block
   so it survives edits to the base rule. */
@media (max-width: 768px) {
  .chat-input-bar {
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  }
}
```

- [ ] **Step 2: workspace.css — extend the iOS zoom guard**

Find the `@media (pointer: coarse)` block whose body forces `font-size: 16px !important` (anchor: the comment about iOS focus-zoom around it; the selector list covers `input[type="text"]`-style entries, textarea, select). ADD to its selector list:

```css
  input[type="date"],
  input[type="time"],
  input[type="datetime-local"],
  input[type="tel"],
```

(Temporal inputs exist in the calendar event form (.cal-input, 12px), notes
reminders, email snooze, assistant check-in — focusing any of them zoomed the
page and the zoom STICKS in standalone mode.)

- [ ] **Step 3: workspace.css — scrollable chat tables (append at end):**

```css
/* ── Chat markdown tables: side-scroll instead of hard clip (review D2) ──
   .msg has overflow:hidden and .chat-history overflow-x:hidden; the mobile
   block gave pre/cmd/details overflow-x:auto but skipped tables — columns
   past the bubble edge were unreachable on a phone. display:block makes the
   table its own scrollbox (header/body stay column-aligned: one <table>). */
.msg table {
  display: block;
  max-width: 100%;
  width: max-content;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
```

- [ ] **Step 4: Verify + commit**

Sanity: `grep -c "safe-area-inset-bottom" frontend-overrides/hermes.css` ≥1;
tables block present once.

```bash
git add frontend-overrides/hermes.css frontend-overrides/workspace.css
git commit -m "fix(mobile-css): composer home-indicator clearance; temporal-input zoom guard; scrollable tables"
```

---

### Task 7: CSS — touch targets, gw-banner/theme-popup safe-area, dvh order

**Files:**
- Modify: `frontend-overrides/workspace.css` (append-only block at end; EXCEPT the #gw-banner edit which modifies its existing rule)

- [ ] **Step 1: #gw-banner safe-area** — find its rule (anchor: `#gw-banner`; currently `padding: 7px 14px` with `position: fixed; top: 0`) and change the padding line to:

```css
  padding: 7px 14px;
  padding-top: calc(7px + env(safe-area-inset-top, 0px));
```

- [ ] **Step 2: Append at end of workspace.css:**

```css
/* ── Mobile touch ergonomics + sheet fixes (2026-06-12 review D1/D4/D5/D6) ── */
@media (pointer: coarse) {
  /* The Hermes icon strip is the ONLY nav on mobile but kept desktop 34px
     buttons; 44px is the tap-target floor. The strip is a wrapping flex row
     inside the drawer — bigger buttons wrap to more rows, they don't clip. */
  .icon-rail-btn { width: 44px; height: 44px; }
  /* Tool-call expander is the main way to inspect agent work on a phone. */
  .agent-thread-header { padding: 8px 0; }
  /* Composer model chip: 21px tall upstream. */
  .model-picker-btn { min-height: 30px; }
  /* Cron panel controls (deliberately not bottom-sheeted; just make the
     existing card tappable). */
  .cron-modal-close { min-width: 44px; min-height: 44px; }
  .cron-btn { padding: 8px 12px; }
  /* Session rows use 500ms long-press for the context menu — suppress iOS
     text-selection/callout fighting the hold (D6). */
  #session-list .list-item {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
}

@media (max-width: 768px) {
  /* Theme designer sheet: 65vh + no bottom inset put the last control row in
     the home-indicator zone (and behind the URL bar in-browser). */
  #theme-popup {
    height: 65dvh !important;
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  }
  /* style.css declares 85dvh THEN 85vh (same specificity) so vh wins in every
     dvh-capable browser — inverted fallback. Re-assert dvh here (this sheet
     loads last). Selector list mirrors style.css's bottom-sheet block. */
  .modal-content,
  .memory-modal-content,
  .settings-modal-content {
    max-height: 85dvh !important;
  }
}
```

BEFORE committing, verify the selector list for the 85dvh fix against
style.css (anchor: `max-height: 85dvh !important`) — mirror exactly the
selectors that carry the inverted pair, no more no less. Also verify
`.icon-rail-btn` is the real strip button class (`grep -n "icon-rail-btn" frontend-vendor/style.css frontend-overrides/hermes.css | head`) and that hermes.css's strip container wraps (`flex-wrap`) — if it doesn't wrap, add `flex-wrap: wrap;` to the strip container selector in the same block.

- [ ] **Step 3: Commit**

```bash
git add frontend-overrides/workspace.css
git commit -m "polish(mobile-css): 44px nav targets, banner/theme-sheet safe-area, dvh fallback order, long-press select suppression"
```

---

### Task 8: Pull-to-refresh — composer exclusion + horizontal release; jump-to-bottom live target

**Files:**
- Modify: `frontend-overrides/js/pull-to-refresh.js`
- Modify: `frontend-overrides/index.html` (scroll-bottom inline script)

- [ ] **Step 1: PTR touchstart — never arm on the composer / while typing**

Anchor:

```js
    var t = e.target;
    if (t && t.closest && t.closest(LAYERS)) { armed = false; return; }
```

Insert after it:

```js
    // Never claim drags that start on the composer or any text field, and
    // stand down entirely while the keyboard is up: the iOS "swipe down to
    // dismiss keyboard" gesture starts exactly here, and a reload would eat
    // the unsent draft (there is no draft persistence).
    var ae = document.activeElement;
    if ((t && t.closest && t.closest('.chat-input-bar, textarea, input, [contenteditable="true"]')) ||
        (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable))) {
      armed = false; return;
    }
```

- [ ] **Step 2: PTR touchmove — release on horizontal dominance**

Anchor (inside the touchmove handler, the `if (!pulling) {` block):

```js
    if (!pulling) {
      if (dy > ARM_SLOP) pulling = true;       // it's a pull — claim it
```

The handler currently never reads X. Capture `startX` in touchstart
(`startX = e.touches[0].clientX;` next to `startY = ...`, declare
`var startX = 0;` beside `startY`), then change the block to:

```js
    if (!pulling) {
      var dx = Math.abs(e.touches[0].clientX - startX);
      if (dx > Math.abs(dy)) { armed = false; return; }  // horizontal intent (sidebar edge-swipe) — let go
      if (dy > ARM_SLOP) pulling = true;       // it's a pull — claim it
```

- [ ] **Step 3: Jump-to-bottom — recompute target during streaming + re-stick**

In `frontend-overrides/index.html`, the inline scroll-bottom script (anchor:
`const target = container.scrollHeight - container.clientHeight;` inside the
`bottomBtn` click handler). Replace the handler body's scrolling part:

```js
      // Target recomputed each frame: during streaming the bottom keeps
      // moving and a once-captured target lands the user short (review D7).
      _scrollingToBottom = true;
      if (window.uiModule && window.uiModule.setAutoScroll) window.uiModule.setAutoScroll(true);
      function step() {
        if (!_scrollingToBottom) return;
        const target = container.scrollHeight - container.clientHeight;
        const diff = target - container.scrollTop;
        if (diff <= 8) { container.scrollTop = target; _scrollingToBottom = false; return; }
        container.scrollTop += diff * 0.2;
        _scrollRaf = requestAnimationFrame(step);
      }
      step();
      _scrollTimeout = setTimeout(() => {
        if (_scrollingToBottom) {
          container.scrollTop = container.scrollHeight - container.clientHeight;
          _scrollingToBottom = false;
        }
      }, 1500);
```

Check `window.uiModule` is actually exposed (`grep -n "window.uiModule" frontend-overrides/app.js`); if not, use `window.odysseusUI` or whatever global the codebase exposes — if none exists, dispatch `document.dispatchEvent(new CustomEvent('jump-to-bottom'))` and add a one-line listener in app.js next to the autoscroll wiring (anchor: `uiModule.setAutoScroll(false)` in the wheel handler) that calls `uiModule.setAutoScroll(true)`.

- [ ] **Step 4: Verify + commit**

`node --check frontend-overrides/js/pull-to-refresh.js` → clean (index.html inline JS: eyeball balance of braces; optionally extract-and-check with sed into /tmp).

```bash
git add frontend-overrides/js/pull-to-refresh.js frontend-overrides/index.html
git commit -m "fix(mobile): PTR never claims composer/keyboard-dismiss drags; jump-to-bottom tracks live bottom"
```

---

### Task 9: chat.js — keyboard-yank guard, resume re-sync, cheaper stream measure

**Files:**
- Modify: `frontend-overrides/js/chat.js`

- [ ] **Step 1: Don't blur a composing user at stream end**

Anchor:

```js
        if (messageInput) {
          messageInput.disabled = false;
          if (window.innerWidth <= 768) {
            messageInput.blur();
          } else {
            messageInput.focus();
          }
        }
```

Replace with:

```js
        if (messageInput) {
          messageInput.disabled = false;
          if (window.innerWidth <= 768) {
            // Blur to dismiss the keyboard — but NOT if the user is mid-
            // composition (input re-enables during the stream so they can
            // type the follow-up; yanking the keyboard then loses iOS
            // autocorrect state and their flow).
            if (document.activeElement !== messageInput || !messageInput.value.trim()) {
              messageInput.blur();
            }
          } else {
            messageInput.focus();
          }
        }
```

- [ ] **Step 2: Resume re-sync — recovery path reloads the session like wasDiscarded does**

Anchor (the recovery abort handler):

```js
          if (abortReason === 'recovery') {
```

That branch appends the "[Streaming was interrupted…]" note and returns. ADD,
just before its `currentAbort = null; return;`:

```js
            // iOS suspends the PWA on every app switch >30s; the fetch dies
            // but the BRAIN finishes server-side. Reload the session (same as
            // the wasDiscarded path) so the persisted reply replaces the
            // stale partial instead of hiding until a manual switch.
            setTimeout(() => {
              try {
                const sid = sessionModule && sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId();
                if (sid) sessionModule.selectSession(sid);
              } catch (e) { /* keep the partial visible */ }
            }, 800);
```

Verify `sessionModule` is in scope at that point (it's imported at the top of
chat.js — `grep -n "sessionModule" frontend-overrides/js/chat.js | head -3`).

- [ ] **Step 3: Skip the per-frame offscreen measure unless content grew meaningfully**

Anchor (inside `_renderStream`, the smooth-expand branch):

```js
        if (!_hasThinking && !_isAgentRound) {
          // Render into offscreen clone to measure new height before swapping
```

Wrap the measure in a growth guard. Above `if (!_measureDiv)` add nothing; instead change the outer condition line to:

```js
        const _grewEnough = (contentEl.textContent.length - (contentEl._lastMeasuredLen || 0)) >= 256;
        if (!_hasThinking && !_isAgentRound && (_grewEnough || !contentEl._lastMeasuredLen)) {
```

and right after the existing `contentEl.style.minHeight = Math.max(curMin, measuredH) + 'px';` line add:

```js
          contentEl._lastMeasuredLen = contentEl.textContent.length;
```

(The measure pass forces a synchronous reflow between DOM writes EVERY frame;
min-height only exists to stop scroll jitter — re-measuring every ~256 chars
keeps that while cutting the layout work an order of magnitude. The final
render path outside _renderStream is untouched, so end-state layout is exact.)

- [ ] **Step 4: Verify + commit**

`node --check frontend-overrides/js/chat.js` → clean.

```bash
git add frontend-overrides/js/chat.js
git commit -m "fix(mobile): keep keyboard up when composing at stream end; resume reloads session; throttle stream measure pass"
```

---

### Task 10: app.js keyboard-scroll guard; sessions.js draft stash + long-press menu guard

**Files:**
- Modify: `frontend-overrides/app.js`
- Modify: `frontend-overrides/js/sessions.js`

- [ ] **Step 1: Keyboard-open scroll respects the autoscroll guard**

Anchor in app.js (visualViewport resize handler):

```js
      if (delta < -50) {
        const hist = document.getElementById('chat-history');
        if (hist) {
```

Change the inner condition to:

```js
      if (delta < -50) {
        // Only chase the bottom if the user was already pinned there —
        // opening the keyboard to quote/copy an earlier message must not
        // yank them down (review C4). uiModule guards every other scroller.
        const hist = document.getElementById('chat-history');
        if (hist && uiModule.getAutoScroll()) {
```

(`uiModule` is imported at app.js top; verify with `grep -n "^import.*ui.js" frontend-overrides/app.js`.)

- [ ] **Step 2: sessions.js — per-session composer draft stash**

Anchor: `msgInput.value = '';` inside `selectSession` (it's the one around the
history load, NOT the one in the send path — context shows it near
`selectSession`; confirm by reading 10 lines around each hit). Replace with:

```js
      // Per-session draft stash: peeking at another chat must not eat a
      // half-typed message (review C6). In-memory only — survives session
      // switches, not reloads.
      if (!window._composerDrafts) window._composerDrafts = new Map();
      const _prevSid = _currentSessionId;
      if (_prevSid && msgInput.value.trim()) window._composerDrafts.set(_prevSid, msgInput.value);
      else if (_prevSid) window._composerDrafts.delete(_prevSid);
      msgInput.value = window._composerDrafts.get(sessionId) || '';
```

IMPORTANT: the variable names `_currentSessionId`/`sessionId` are
illustrative — read the surrounding function to find the real names of (a) the
previous session id before the switch and (b) the target session id, and use
those. If the previous id isn't available at that point, capture it at the top
of `selectSession` before it's overwritten. Also clear the draft on actual
send: in the send path (`grep -n "msgInput.value = ''" frontend-overrides/js/sessions.js` — the OTHER hit, in the send/disable path) add
`if (window._composerDrafts) window._composerDrafts.delete(<current sid>);`
ONLY if that path is a send (read it first; if it's unrelated, find where the
message is actually submitted — likely chat.js handleChatSubmit — and skip
this sub-step if it's cross-file; the stash self-heals on next switch anyway).

- [ ] **Step 3: sessions.js — long-press menu: ignore the iOS synthetic click**

Anchor (inside the long-press timer, the close-on-tap-outside wiring):

```js
        const close = (ev) => { if (!dd.contains(ev.target)) { dd.style.display = 'none'; document.removeEventListener('click', close, true); } };
        setTimeout(() => document.addEventListener('click', close, true), 100);
```

Replace with:

```js
        // iOS fires a synthetic click after touchend (workspace-explorer.js
        // documents the same trap) — if the finger lifts >100ms after the
        // menu opened, that click would instantly dismiss it. Ignore clicks
        // for 700ms after open.
        const _openedAt = Date.now();
        const close = (ev) => {
          if (Date.now() - _openedAt < 700) return;
          if (!dd.contains(ev.target)) { dd.style.display = 'none'; document.removeEventListener('click', close, true); }
        };
        setTimeout(() => document.addEventListener('click', close, true), 100);
```

- [ ] **Step 4: Verify + commit**

`node --check frontend-overrides/app.js frontend-overrides/js/sessions.js` (run separately; node --check takes one file).

```bash
git add frontend-overrides/app.js frontend-overrides/js/sessions.js
git commit -m "fix(mobile): keyboard-open scroll respects autoscroll; per-session draft stash; long-press menu survives synthetic click"
```

---

### Task 11: Backend efficiency — inbox cache TTL; workspace root in /api/config

**Files:**
- Modify: `backend/inbox/__init__.py`, `backend/app.py`, `frontend-overrides/js/inbox.js`, `frontend-overrides/js/hermes-footer.js`
- Test: `backend/tests/test_inbox_router.py` (extend), `backend/tests/test_app_config.py` (create or extend existing config test file — check `grep -rln "api/config" backend/tests/`)

- [ ] **Step 1: Failing tests**

```python
# in the inbox test file
def test_cache_ttl_outlives_dot_poll():
    """The unread-dot polls every 120s; TTL must exceed it or every poll
    re-runs the gmail/slack/asana collectors (0.9s+ on the mini)."""
    from backend import inbox
    assert inbox.CACHE_TTL_MS >= 150_000
```

```python
# config test
def test_config_includes_workspace_root():
    from fastapi.testclient import TestClient
    from backend.app import app
    d = TestClient(app).get("/api/config").json()
    assert "workspace_root" in d and isinstance(d["workspace_root"], str)
```

- [ ] **Step 2: Run, verify fail.** `../../.venv/bin/python -m pytest backend/tests/test_inbox_router.py backend/tests/test_app_config.py -q`

- [ ] **Step 3: Implement**

`backend/inbox/__init__.py`: `CACHE_TTL_MS = 60_000` → `CACHE_TTL_MS = 150_000`
(comment: `# Must outlive the frontend's 120s dot poll or every poll re-runs the collectors.`)

`backend/app.py` `/api/config` handler — add the workspace root (find what
workspace_files uses as its root: `grep -n "ROOT\|root" backend/workspace_files.py | head` — reuse that source of truth):

```python
    return {
        "agent_name": config.agent_name(),
        "accent": config.accent_color(),
        # The footer shows this; previously it fetched the ENTIRE workspace
        # tree walk just to read .root (2026-06-12 mobile review E2).
        "workspace_root": str(workspace_root_path()),
    }
```

(adapt `workspace_root_path()` to the real accessor in workspace_files.py /
config.py.)

`frontend-overrides/js/inbox.js`: `60000` → `120000` in the dot interval
(anchor: `setInterval(() => { if (!document.hidden) refreshInboxDot(); }, 60000);`) and update the comment above it (`every 60s` → `every 120s; server cache TTL is 150s so these hit cache`).

`frontend-overrides/js/hermes-footer.js`: in the `/api/config` fetch handler
(anchor: `--hermes-agent-initial`), set the path from config and only fall
back to the tree fetch when absent:

```js
    fetch('/api/config').then(r => r.ok ? r.json() : null).then(cfg => {
      const name = (cfg && (cfg.agent_name || cfg.name)) || '';
      if (name) document.documentElement.style.setProperty('--hermes-agent-initial', JSON.stringify(name[0].toUpperCase()));
      if (path && cfg && cfg.workspace_root) {
        path.textContent = cfg.workspace_root; path.title = cfg.workspace_root; path.hidden = false;
      } else if (path) {
        // Old backend without workspace_root: fall back to the tree endpoint.
        fetch('/api/workspace/tree').then(r => r.ok ? r.json() : null).then(d => {
          if (d && d.root) { path.textContent = d.root; path.title = d.root; path.hidden = false; }
        }).catch(() => {});
      }
    }).catch(() => {});
```

and DELETE the old standalone `if (path) { fetch('/api/workspace/tree')...}` block.

- [ ] **Step 4: Run tests + node --check both js files; commit**

```bash
git add backend/inbox/__init__.py backend/app.py backend/tests frontend-overrides/js/inbox.js frontend-overrides/js/hermes-footer.js
git commit -m "perf(mobile): inbox dot stops defeating server cache; footer path from /api/config (no tree walk)"
```

---

### Task 12: Frontend efficiency — boot-fetch memo, fetch timeouts, stray timers, panels observer bail

**Files:**
- Modify: `frontend-overrides/index.html` (tiny inline helper), `frontend-overrides/app.js`, `frontend-overrides/js/strip-order.js`, `frontend-overrides/js/search.js`, `frontend-vendor/js/init.js`, `frontend-vendor/js/models.js`, `frontend-overrides/js/gateway-status.js`, `frontend-overrides/js/hermes-panels.js`

- [ ] **Step 1: Shared boot-fetch memo (inline, before all module tags)**

In `frontend-overrides/index.html`, inside the FIRST inline `<script nonce="{{CSP_NONCE}}">` boot block (anchor: `window._odysseusLoadTime = Date.now();` — add right after that line):

```js
  // Boot fetch memo: app boot fires ~18 API calls, several duplicated across
  // modules (/api/auth/status ×2, /api/auth/settings ×3, /api/models ×2).
  // Same-URL GETs within 10s share one request+parse. Window-scoped so the
  // pre-module scripts (strip-order, search) and modules all see it.
  window.__memoJson = (function () {
    var inflight = new Map();
    return function (url) {
      var hit = inflight.get(url);
      if (hit) return hit;
      var p = fetch(url, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
      inflight.set(url, p);
      setTimeout(function () { inflight.delete(url); }, 10000);
      return p;
    };
  })();
  // Status/list fetches must not hang for minutes on a half-dead tailnet
  // link (review E7): same fetch, 8s abort.
  window.__fetchT = function (url, opts, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms || 8000);
    return fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}, { signal: ctl.signal }))
      .finally(function () { clearTimeout(t); });
  };
```

- [ ] **Step 2: Route the duplicated call sites through the memo**

Each site keeps its own `.then` logic; only the fetch+json changes. Adapt to
the exact surrounding code (read each first):

- `frontend-overrides/app.js` anchor `fetch(\`${API_BASE}/api/auth/status\`` →
  `(window.__memoJson ? window.__memoJson(\`${API_BASE}/api/auth/status\`) : fetch(\`${API_BASE}/api/auth/status\`, { credentials: 'same-origin' }).then(r => r.json()))` — then the following `.then(...)` chain consumes parsed JSON directly (remove its own `r.json()` step; null-guard: first `.then` should bail on falsy data).
- `frontend-overrides/app.js` anchor `fetch(\`${API_BASE}/api/auth/settings\`` (same treatment).
- `frontend-overrides/js/strip-order.js` anchor `fetch('/api/auth/settings').then(r => r.ok ? r.json() : null)` → `(window.__memoJson ? window.__memoJson('/api/auth/settings') : fetch('/api/auth/settings').then(r => r.ok ? r.json() : null))`. (Only the GET — the POSTs stay raw fetch.)
- `frontend-overrides/js/search.js` `_fetchProvider` GET → same memo wrap.
- `frontend-vendor/js/init.js` anchor `fetch('/api/auth/status', { credentials: 'same-origin' })` → memo wrap (vendor edit is sanctioned: upstream dead; precedent slashCommands.js).
- `frontend-vendor/js/models.js` GET `/api/models` (anchor: `'/api/models'`) → memo wrap, and `frontend-overrides/app.js` `/api/models` fetch → memo wrap.

- [ ] **Step 3: Timeouts on status polls**

- `frontend-overrides/js/gateway-status.js`: in `refresh()` (anchor: `function refresh`) replace its `fetch(` with `(window.__fetchT || fetch)(` and ALSO guard the interval (anchor: `setInterval(refresh, POLL_MS);`) →
  `setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);` (every other poll in the app already has the hidden guard).
- `frontend-overrides/js/inbox.js`: `_fetchItemIds` and the main list `load()` fetch (read the file, anchors: `async function _fetchItemIds`, `/api/items`) → `(window.__fetchT || fetch)(`.

- [ ] **Step 4: hermes-panels — ignore chat-stream mutations**

Anchor in `frontend-overrides/js/hermes-panels.js`:

```js
    const kick = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; sync(); }); };
    new MutationObserver(kick).observe(document.body, {
```

Replace with:

```js
    // Streaming rewrites #chat-history every frame; panels never live there —
    // don't pay a panel-geometry sync per token (review E5).
    const kick = (muts) => {
      if (muts && muts.length && muts.every((m) => {
        const t = m.target;
        return t && t.nodeType === 1 && t.closest && t.closest('#chat-history');
      })) return;
      if (!raf) raf = requestAnimationFrame(() => { raf = null; sync(); });
    };
    new MutationObserver(kick).observe(document.body, {
```

(`muts.every` keeps correctness: a batch that contains ANY non-chat mutation
still syncs. Text-node targets (nodeType 3) fail the closest check → counted
as non-chat → sync runs; that's the safe direction.)
BEWARE the memory note: setActive must stay mutation-idempotent — this change
only FILTERS mutations, never adds new sync calls; do not restructure sync().

- [ ] **Step 5: Verify + commit**

`node --check` every touched .js file. Then full suite:
`../../.venv/bin/python -m pytest backend/tests -q` → 1 pre-existing docx failure only.

```bash
git add frontend-overrides/index.html frontend-overrides/app.js frontend-overrides/js/strip-order.js frontend-overrides/js/search.js frontend-vendor/js/init.js frontend-vendor/js/models.js frontend-overrides/js/gateway-status.js frontend-overrides/js/inbox.js frontend-overrides/js/hermes-panels.js
git commit -m "perf(mobile): dedupe boot fetches, 8s timeouts on status polls, panels observer skips chat stream"
```

---

### Task 13: Holistic review + scratch build + docs

- [ ] **Step 1: Full test suite** — `../../.venv/bin/python -m pytest backend/tests -q` → only the pre-existing docx failure.
- [ ] **Step 2: node --check sweep** — `for f in frontend-overrides/app.js frontend-overrides/js/*.js frontend-vendor/sw.js frontend-vendor/js/init.js frontend-vendor/js/models.js; do node --check "$f" || echo "FAIL $f"; done`
- [ ] **Step 3: Scratch sync build** — `WORKSPACE_BUILD_DEST=/tmp/pwa-final bash scripts/sync-frontend.sh` → verify: precache injected (>60 entries incl. hermes.css), CACHE_NAME stamped, `node --check /tmp/pwa-final/sw.js`, `grep register /tmp/pwa-final/index.html` shows `/sw.js`, no `?v=` module tags, modulepreload count ~40. Clean up `/tmp/pwa-final`.
- [ ] **Step 4: Re-read the spec end-to-end; confirm every A-F item is implemented or explicitly deferred (E4's app.js rail-interval half was found ALREADY guarded — gateway-status only). Fix gaps.**
- [ ] **Step 5: Commit spec+plan docs**

```bash
git add docs/superpowers/specs/2026-06-12-mobile-pwa-polish-design.md docs/superpowers/plans/2026-06-12-mobile-pwa-polish.md
git commit -m "docs: mobile PWA polish spec + plan (2026-06-12 review)"
```

---

### Integration (main session only — NOT a subagent task)

1. Check the MAIN checkout: if the concurrent session's work is still
   uncommitted (`git -C /Users/admin/openclaw-workspace status --short`), STOP
   — hand off the branch, do not stash or deploy.
2. If clean: `git merge mobile-pwa-polish` (or rebase), resolve, re-run pytest.
3. Deploy frontend: `bash scripts/sync-frontend.sh` (stamps CACHE_NAME + precache).
4. Backend: probe whether uvicorn auto-reloaded (`curl -s localhost:8800/sw.js -o /dev/null -w '%{http_code}'` → 200 means new code live); otherwise the gzip/sw-route/config changes need the user-gated
   `launchctl kickstart -k gui/$(id -u)/ai.openclaw.workspace` (2014-mini cold-start caveats apply).
5. User browser smoke list is in the spec (§ Verification policy).
