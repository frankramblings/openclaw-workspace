# Mobile PWA polish batch — design spec (2026-06-12)

Source: full mobile-focused code review (4 parallel passes: PWA shell/SW, layout CSS,
touch-interaction JS, mobile perf), every finding below verified against the code at
ba10db2. Primary client: iPhone, iOS Safari **standalone PWA**, over Tailscale
(8443 https origin via Serve → 127.0.0.1:8800; sometimes :8800 直接). Server: 2014
Mac mini — server CPU and wire bytes both matter.

**Concurrent-session note:** another agent has UNCOMMITTED work in the main checkout
(mobile top-bar safe-area rework in workspace.css, 44px send button + text-size
feature in hermes.css/index.html/theme.js, attach-via-label in app.js/index.html/
fileHandler.js, `{type:"metrics"}` frame in backend/app.py + chat.js). This batch is
built on branch `mobile-pwa-polish` in `.worktrees/`, deliberately does NOT touch
those areas, and places CSS additions in self-contained blocks (end of file /
workspace.css mobile section) to merge cleanly.

## Out of scope (consciously deferred, do not creep)

- Enter-to-send vs newline on mobile keyboards — product decision for the user
  (current: Enter always sends; iOS keyboard can't type a newline in the composer).
- History render chunking/virtualization for 150+-message threads.
- Inter font subsetting; /api/boot endpoint consolidation; sidebar-layout.js
  passive-listener refactor; landscape notch insets; maskable icon 513→512 re-export.
- Everything in the standing rejected/deferred lists of the 2026-06-10/12 batches.

---

## Theme A — Make the service worker actually work (P0 + followups)

### A1 (P0) SW never controls the app — scope is /static/
`index.html:2371` registers `/static/sw.js` with default scope → max scope
`/static/`; the SPA lives at `/` (app.py catch-all). An uncontrolled page gets no
fetch events: the entire offline story, the 60-file precache, and every CACHE_NAME
bump have been inert. Offline launch of the installed PWA = Safari error page.

**Fix:** dedicated backend route `GET /sw.js` → `FileResponse(frontend/sw.js,
media_type="application/javascript")` with `Cache-Control: no-cache`, registered
BEFORE the catch-all; change the register call to
`navigator.serviceWorker.register('/sw.js')`. The old `/static/sw.js` registration
on both origins is superseded per-origin on next visit (same-origin re-register at
broader scope). Backend test: route exists, right content-type, no-cache header.

### A2 (P1) `?v=` on chat.js double-instantiates a 4.6k-line module
`index.html:2360` loads `/static/js/chat.js?v=20260520m` while `app.js:12` imports
`./js/chat.js` bare → two module instances (the exact `sessions.js?v=` bug class,
memory `feedback_esm_version_query_double_load`). chat.js's top-level
body-MutationObserver attaches twice → every streaming mutation scanned twice.
`app.js?v=20260607a` (index.html:2369) + bare modulepreload also double-downloads
app.js per cold load.

**Fix:** drop both `?v=` queries; rewrite the comment at 2369 that instructs future
editors to bump `?v=` ("bump CACHE_NAME via sync-frontend.sh instead"). No other
`?v=` module tags exist (verify with grep at implementation time).

### A3 (P1) PRECACHE list is stale → first offline open after update boots a broken shell
`frontend-vendor/sw.js:15-64` lists none of: workspace.css, hermes.css, the nine
injected overlay modules (cron.js, inbox.js, gateway-status.js, skills-toggle.js,
capabilities.js, hermes-footer.js, workspace-explorer.js, strip-order.js,
hermes-panels.js), pull-to-refresh.js, vaultLinks.js, researchSynapse.js,
assistant.js, tourAutoplay.js — and still precaches the commented-out
voiceRecorder.js. activate wipes old caches, so post-update offline boot = unstyled
half-shell.

**Fix:** generate PRECACHE at sync time. Vendor sw.js keeps a literal token line
`const PRECACHE_FILES = [/*__PRECACHE__*/];` (plus `/` added in code);
`scripts/sync-frontend.sh` (which already walks frontend/ to compute ASSET_HASH)
emits the actual deployed file list (`/static/...` for *.js *.css fonts icons
manifest) into the token right before stamping CACHE_NAME. Keep the list to
GET-able static assets; exclude sw.js itself.

### A4 (P2) sync-script hygiene: manifest.json missing from ASSET_HASH; md5 is macOS-only
The ASSET_HASH `find` matches `*.webmanifest` but the real file is `manifest.json`;
icon PNGs excluded too (acceptable — self-heals via cache-first-with-refresh).
`md5 -q` doesn't exist on Linux → public-repo CI/users hit a `set -e` death with
sw.js stuck at the vendor CACHE_NAME constant.

**Fix:** add `-o -name 'manifest.json'` to the find; portable hash helper
(`command -v md5 || md5sum`).

### A5 (P2) iOS home-screen icon is the soft 192px downscale
`index.html:17` points apple-touch-icon at `icon-192.png` while a purpose-built
180×180 `apple-touch-icon.png` ships unused. **Fix:** point the link at
`/static/apple-touch-icon.png`.

### A6 (P2) Offline boot on a blackholed link waits for full TCP timeouts
sw.js network-first falls back to cache only on rejection; a half-dead tailnet
link hangs each request 60s+. **Fix:** in sw.js's JS/CSS/navigation fetch paths,
race the network fetch against a ~4s timer and fall back to cache on timeout
(network still wins when it responds; cache miss → wait for network as today).

## Theme B — Wire weight & startup waterfall

### B1 (P1) No response compression anywhere
No GZipMiddleware in backend/app.py; Tailscale Serve doesn't compress. Measured:
style.css 1,084,648 B raw → 227,395 B gzipped; index.html 200,601 → 35,482;
app.js 172,232 → 47,079. Every cold install / CACHE_NAME bump re-downloads ~1.5MB+
raw; API JSON also uncompressed. **Fix:**
`app.add_middleware(GZipMiddleware, minimum_size=1024)`. SSE is safe — the stream
responses are `text/event-stream` via StreamingResponse; verify GZipMiddleware
skips streaming responses (it buffers only sized responses; confirm by test that
/api/chat/stream still streams — there is an existing SSE test to piggyback).

### B2 (P1) mermaid (~905KB gz, ~2.8MB parse) + KaTeX load eagerly from CDN on every boot
`index.html:204-205` load both unconditionally; `mermaid@11` is a range alias
(short CDN max-age). Lazy hooks already exist (`window.odysseusInitMermaid`
wiring index.html:206-215; `markdownModule.renderMermaid` chat.js:2512; precedent:
document.js lazy-loads html2pdf at :7849-7860).

**Fix:** remove the eager tags; inject the script on first use — mermaid when a
```` ```mermaid ```` fence is about to render, KaTeX when TeX delimiters are
detected by the existing math path (only if markdown.js has a clean single
gateway; if not, KaTeX may stay eager — mermaid is the big win). Pin mermaid to an
exact version. Keep `odysseusInitMermaid` semantics so already-rendered diagrams
re-init.

### B3 (P1) modulepreload covers 5 of ~50 modules
`index.html:217-221` preloads app.js/chat.js/ui.js/sessions.js/markdown.js; the
second tier (notes, calendar, emailInbox→emailLibrary/*, modalManager, providers,
slashCommands, modelPicker, keyboard-shortcuts, sidebar-layout,
section-management, research/panel, group, dragSort, researchSynapse …) is only
discovered after app.js downloads+parses → 2-3 extra RTT waves at 50-200ms RTT.

**Fix:** hand-curate the static-import graph of app.js/chat.js/ui.js/sessions.js
(grep the import statements; ~20-25 modules) into `<link rel="modulepreload">`
tags. Do NOT blanket-preload all of js/ (dead-chrome modules like gallery.js
would become new downloads). Verify each preloaded file is actually statically
imported.

## Theme C — Composer & keyboard correctness

### C1 (P1) Capsule composer lost its home-indicator safe-area padding
hermes.css `.chat-input-bar` uses the `padding` shorthand at equal specificity,
loaded after style.css's mobile rule `padding-bottom: calc(10px +
env(safe-area-inset-bottom))` (style.css:3972) → wiped. Bottom control row sits in
the home-indicator gesture zone. **Fix:** self-contained block APPENDED at end of
hermes.css: `@media (max-width: 768px) { .chat-input-bar { padding-bottom:
calc(10px + env(safe-area-inset-bottom, 0px)); } }` (append-only → merges cleanly
with the concurrent session's edits to the base rule).

### C2 (P1) Stream-end blur yanks the keyboard mid-composition
chat.js ~2822: on stream end, `window.innerWidth <= 768 → messageInput.blur()` —
but the input is deliberately re-enabled mid-stream for composing the next
message. **Fix:** only blur if the user isn't composing:
`if (document.activeElement !== messageInput || !messageInput.value.trim())`.

### C3 (P1) Pull-to-refresh claims drags starting on the composer; reload destroys the draft
pull-to-refresh.js arms on any touch whose target chain is scrolled to top — the
one-line textarea always qualifies; LAYERS excludes modals but not the composer.
Keyboard-dismiss swipes (Messages muscle memory) → resisted pull → location.reload()
→ typed draft gone. Also no horizontal-dominance release → fights the edge
swipe-to-open-sidebar. **Fix:** in touchstart, bail when
`t.closest('.chat-input-bar, textarea, input, [contenteditable]')` or when
`document.activeElement` is a text field; in touchmove before claiming, release
when `Math.abs(dx) > dy`.

### C4 (P2) Keyboard-open handler force-scrolls to bottom, ignoring the autoscroll guard
app.js:3371-3386: any visualViewport shrink >50px does `hist.scrollTop =
hist.scrollHeight` even when the user scrolled up to quote something. **Fix:**
wrap in `if (uiModule.getAutoScroll())`.

### C5 (P1) iOS sticky focus-zoom guard misses temporal inputs
workspace.css:505-513 forces 16px on text-ish inputs but not
`date/time/datetime-local/tel`. Real instances: calendar event form
(.cal-input is 12px), notes reminders, email snooze, assistant check-in. Focus →
page auto-zooms and the zoom sticks in standalone. **Fix:** add those types to
the same `@media (pointer: coarse)` rule.

### C6 (P2) Session switch silently wipes the composer draft
sessions.js:1634-1638 `msgInput.value = ''` unconditionally. **Fix:** per-session
in-memory draft stash (Map keyed by session id, saved before switch, restored
after; no persistence needed).

## Theme D — Touch ergonomics & small-screen polish

### D1 (P2) Primary nav touch targets are 34×34 (icon strip), 21px (model chip), ~20px (tool-card header)
The Hermes strip is the ONLY nav on mobile (sidebar rows hidden) but keeps desktop
sizing (style.css:674-676, gap 2px hermes.css:197); model-picker chip height 21px
(style.css:2545); `.agent-thread-header` padding 2px (style.css:8425) is the main
way to inspect tool calls. Cron panel controls all sub-30px
(close ≈23px, buttons ≈26px, toggles 34×19). **Fix:** one `@media (pointer:
coarse)` block in workspace.css: `.icon-rail-btn { width:44px; height:44px; }`
(strip is horizontal inside the drawer — verify it wraps/scrolls, not overflows),
`.model-picker-btn { min-height: 30px; }`, `.agent-thread-header { padding: 8px
0; }`, `.cron-modal-close { min-width:44px; min-height:44px; }`, `.cron-btn
{ padding: 8px 12px; }`.

### D2 (P1) Markdown tables hard-clipped in chat bubbles
`.msg { overflow: hidden }` (style.css:1901) + `.chat-history { overflow-x:
hidden }` + no scroll wrapper on `.msg table` → columns past 390px are
unreachable. **Fix (CSS-only):** in workspace.css:
`.msg table { display: block; max-width: 100%; overflow-x: auto;
-webkit-overflow-scrolling: touch; }` (display:block on table keeps
border-collapse rendering inside the scrollbox; verify visually with a wide table).

### D3 (P2) #gw-banner draws under the iOS status bar
workspace.css:406-409 fixed top:0 with no safe-area inset — exactly the banner you
need to read ("gateway restarting"). **Fix:** `padding-top: calc(7px +
env(safe-area-inset-top, 0px));`.

### D4 (P2) Theme designer sheet: 65vh + no bottom safe-area
style.css:6111-6122 pins #theme-popup to bottom:0 with `height: 65vh !important`
and 12px bottom padding. **Fix in workspace.css:** `@media (max-width: 768px)
{ #theme-popup { height: 65dvh !important; padding-bottom: calc(12px +
env(safe-area-inset-bottom, 0px)); } }`.

### D5 (P2) dvh/vh fallback order inverted on bottom-sheet modals
style.css:6144-6145 + 7040-7041 declare `85dvh !important` THEN `85vh !important`
— later wins, so vh is used in every dvh-capable browser (comment says the
opposite; the 6226-6229 block has it right). **Fix:** re-declare `max-height:
85dvh !important` for the same selector lists in workspace.css (loads last).

### D6 (P2) Session-row long-press fights iOS text selection and self-dismisses
sessions.js:393-425: 500ms hold opens the dropdown; `.list-item` has no
user-select/touch-callout suppression → native selection + callout over the menu;
the document click-closer armed at +100ms has no synthetic-click guard (iOS fires
a click after touchend — workspace-explorer.js:413-417 documents this and uses a
700ms suppression window). **Fix:** workspace.css `@media (pointer: coarse)
{ #session-list .list-item { -webkit-user-select: none; user-select: none;
-webkit-touch-callout: none; } }`; in sessions.js, ignore the first
document-click within ~700ms of menu-open (reuse the explorer pattern).

### D7 (P2) Jump-to-bottom chases a stale target during streaming
index.html:1325-1338 captures `target = scrollHeight - clientHeight` once; during
streaming the bottom keeps moving → lands short, autoscroll doesn't re-engage.
**Fix:** recompute target each animation step; call `uiModule.setAutoScroll(true)`
(via window.uiModule) on tap.

## Theme E — Idle & runtime efficiency

### E1 (P2) Inbox dot poll defeats the server cache
inbox.js:1066 polls every 60s; backend `CACHE_TTL_MS = 60_000` → every poll is a
cache miss re-running the gmail/slack/asana/obsidian collectors (0.89s server time
empty; collectors are subprocess-heavy). **Fix:** server TTL → 150_000; dot poll
interval → 120_000 (dot staleness invisible). Backend test: TTL constant.

### E2 (P2) hermes-footer downloads the whole workspace tree for one path string
hermes-footer.js:16-19 fetches /api/workspace/tree, uses only `d.root`. **Fix:**
add `root` (path string) to `/api/config`'s payload; footer reads it from the
config fetch it already makes; keep tree fallback for old backends. Backend test:
config includes root.

### E3 (P2) Boot fetch storm duplicates
Verified duplicates per cold open: /api/auth/status ×2 (app.js:1105 +
vendor init.js:29), /api/auth/settings ×3 (app.js:1316, strip-order.js:71,
search.js:22), /api/models ×2 (app.js:3189 + vendor models.js:179 — NB models.js
needs its #models div, memory `project_hermes_ui_adoption`). **Fix:** a tiny
shared in-flight-promise memo (window-scoped, e.g. `window.__bootFetchMemo`) used
by the override call sites (app.js, strip-order.js, search.js) so concurrent
duplicates share one request; leave vendor files alone except where already
overridden. 10-second memo window, then passthrough (settings can be re-fetched
fresh later).

### E4 (P3) Stray always-on timers
gateway-status.js:116 30s poll has no document.hidden guard (every other poll has
one); app.js:3521 1Hz `_syncRailDynamic` interval. **Fix:** add hidden guards to
both (keep the rail interval — it's load-bearing for chat-notify sync — just skip
ticks while hidden).

### E5 (P2) hermes-panels body-observer does panel geometry work on every streaming mutation
hermes-panels.js:171-176 observes body subtree; each streamed innerHTML swap kicks
an rAF sync over all PANEL_SPECS. **Fix:** in the observer callback, skip
mutations whose target is inside `#chat-history` (panels never live there). Keep
mutation-idempotency intact (memory: setActive must stay idempotent).

### E6 (P2) Streaming measure-pass forces layout every frame
chat.js _renderStream (~1148-1245): per coalesced frame, full re-render PLUS an
offscreen clone measure (`offsetWidth`/`offsetHeight` reads between writes).
**Fix (conservative):** skip the measure pass unless accumulated text grew ≥256
chars since the last measured length (track `_lastMeasuredLen`); always measure on
the finalize path so the final layout is exact.

### E7 (P2) No fetch timeouts → half-dead link hangs UI states for minutes
Only document.js uses an AbortController timeout. **Fix:** add a
`fetchWithTimeout(url, opts, ms=8000)` helper in the overrides layer and use it in
gateway-status.js refresh, inbox.js load/dot, and the boot status calls in app.js
(NOT the chat stream; NOT uploads). On timeout, existing error paths handle it.

## Theme F — Backgrounding/resume correctness

### F1 (P1) Recovery after iOS suspension shows stale partial reply, never re-syncs
chat.js visibilitychange recovery (3356-3395) aborts the frozen reader with
`_reason='recovery'`; the abort handler (2698-2712) appends "[Streaming was
interrupted…]" but unlike the `document.wasDiscarded` path (3430-3434) never
reloads the session — the server-completed reply stays invisible until manual
switch/reload. On iOS PWA this is the ROUTINE path (app switch >30s kills the SSE
fetch). **Fix:** after the recovery abort settles (~500ms), call
`sessionModule.selectSession(currentSessionId)` exactly like the wasDiscarded
branch, so the persisted reply (or late-reply salvage) renders.

---

## Verification policy (per feedback memories)

- Backend: pytest (310 baseline; 1 pre-existing failure in
  test_documents_export.py::test_export_docx_roundtrip — investigate separately,
  not caused by this batch).
- Frontend: `node --check` every touched JS file; NO headless Chrome on this box.
- Deployed-bytes checks via curl where cheap (gzip header, /sw.js content-type).
- Live deploy (sync-frontend.sh + backend restart) only against a CLEAN main
  checkout — if the concurrent session's work is still uncommitted at integration
  time, stop and hand off with exact commands instead of stashing their work.
- User browser smoke list (cannot be machine-verified): offline relaunch of the
  PWA after one online visit, home-indicator clearance of the composer, table
  side-scroll, keyboard staying up after a reply finishes, draft surviving a
  session peek, PTR no longer hijacking keyboard-dismiss swipes.

## Implementation deviations (as built, 16 commits 669f246..)

- E4's app.js rail-interval half was found ALREADY hidden-guarded — only
  gateway-status.js needed the guard.
- B3 landed 43 modulepreloads (not ~47): the verified static graph, plus
  emailLibrary.js + emailLibrary/replyRecipients.js found during reconciliation.
- B2's mermaid kick was ALSO patched into 4 vendor call sites (chatRenderer ×2,
  slashCommands, group) — without it, history/group/slash renders would never
  trigger the lazy load. KaTeX deliberately stays eager.
- F1's recovery reload gained an `isStreaming` + same-sid guard (final review:
  a Send within 800ms of recovery would have had its live stream wiped).
- E3's memo keys on the ABSOLUTE url (relative/absolute callers must collapse),
  does not cache failures, and runs through the 8s-timeout fetch (covers E7 for
  the boot calls too).
- D5's selector union includes `#compare-model-overlay .modal-content` (read
  from style.css, not the spec draft's 3-selector guess).
- Conscious accepts from final review: SW cache-miss fallback still waits the
  full TCP timeout (per spec); overlay-only sync mode would keep a stale
  precache list (vendor sw.js re-rsync is what refreshes the token — this repo
  has frontend-vendor/, so the live path regenerates it every sync).
