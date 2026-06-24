# Mobile UI polish — Ralph backlog

Task: iterative polish passes on the mobile redesign shell to fix many small
issues. Mobile surface lives in `frontend-overrides/js/redesign/mobile/`
(`mobile.css`, `mobile-app.js`, `mobile-surfaces.js`, `mobile-sheets.js`,
`mobile-data.js`). `frontend-overrides/` is the deployed snapshot we edit directly.

## Loop protocol (one coherent item per iteration)
1. Read this file. Pick the top `[ ]` item.
2. Investigate at `file:line`. Fix if contained (≤ ~1 file, no design decision); else add a `needs human:` note and mark `[!]`.
3. Run `node --test 'frontend-overrides/js/__tests__/*.test.js'` (must stay green — 53 tests).
4. **DEPLOY: run `bash scripts/sync-frontend.sh`.** `/static/` serves the generated `frontend/` dir (gitignored), NOT `frontend-overrides/`. Editing overrides alone changes NOTHING that users see until the sync layers them into `frontend/`. Skip this and every fix is invisible.
5. **VERIFY in-browser** (renderers are HTML-string builders; node tests don't catch layout). Screenshot the live page at a mobile viewport and eyeball the change:
   `chromium --headless --no-sandbox --ignore-certificate-errors --hide-scrollbars --force-device-scale-factor=2 --window-size=390,844 --virtual-time-budget=5000 --screenshot=/home/frank/ralph-shots/<name>.png "https://naboo.bicolor-triceratops.ts.net:8443/static/index-redesign.html#<surface>"`
   Surfaces route off `location.hash`: `#chat #inbox #email #more #calendar #notes #settings` (also `#capture`). Snap chromium can only write under non-hidden `$HOME` dirs (e.g. `/home/frank/ralph-shots/`), not `/tmp`. A persistent `--remote-debugging-port` browser gets SIGTERM'd by the harness, so one-shot `--screenshot` per surface is the only reliable mode.
6. Mark the item `[x]`/`[!]`, append a PROGRESS line, commit `mobile: <one-line>` (note: `frontend/` is gitignored — only `frontend-overrides/` + `ralph/` files get committed), exit.

## Done
- [x] Kill grey iOS tap-flash + press-in scale on small controls (`mobile.css:17-25`) — with reduced-motion guard.
- [x] Composer focus transition + send button dims/inert until text typed (`mobile.css:100-110`).
- [x] Large tap targets (`.m-mail`, `.m-grid-card`, companion handle pill) lost tap feedback when the native highlight was killed — added background-settle on `:active` (`mobile.css:26-30`).
- [x] Chat empty/new-thread rendered a fully blank screen — added centered `.m-chat-zero` prompt ("Message Gary to start") reusing the shared `.inbox-zero` shell (`mobile-surfaces.js` mChat, `mobile.css` `.m-thread.empty`). New chats (`live/chat.js:801,816` set `thread=[]`) now get a friendly placeholder instead of void. Verified both branches render via direct import.

## Backlog (concrete, observed)
- [ ] Dead decorative controls with `cursor:pointer` but no `data-act`: email reader `✦ AI reply` / `✦ Summarize` (`mobile-surfaces.js:152`), `✦ Draft` + reply send button (`:156`), `.m-gary-card` in More hub (`:186`), calendar `Day/Agenda` seg (`:172`). Either wire them or drop the pointer affordance so they don't promise interactivity. — needs decision on wiring vs. stub.
- [x] `.m-mail.active` only highlighted when `e.unread` was truthy (`mobile-surfaces.js:127`) — a read, selected email showed no active state. Fixed: highlight on selection (`i === s.selEmail`) regardless of unread.
- [x] Reduced-motion: sheet slide-up (`m-sheet-up`), status-dot `pulse` (both `.m-gary .status .dot` and `.m-gary-card .st .dot`), and terminal-cursor `blink` are now disabled under `prefers-reduced-motion`. The pull-to-refresh `spin` is intentionally kept — it conveys progress; freezing it reads as broken.
- [x] `:focus-visible` ring added (`.m-app button/textarea/input:focus-visible` → 2px teal outline, 2px offset). Scoped to keyboard/switch focus so it never shows on tap (pointer presses use `:active`). Proven with an autofocus harness: focused control shows the ring, others don't.
- [ ] `.m-tab-badge` position uses a hardcoded `right: calc(50% - 19px)` (`mobile.css:68`) — fragile if label width changes; verify it sits correctly over each tab icon.
- [ ] Quick-add calendar button is `data-act="clearQuick"` showing a `+` (`mobile-surfaces.js:178`) — a plus glyph that clears reads wrong; confirm icon vs. action intent.
- [ ] Email reader archive/dots icon buttons (`mobile-surfaces.js:146-147`) have `border:none` inline override — inconsistent with `.m-icon-btn` elsewhere; confirm intentional.

## Found via mobile screenshot survey (2026-06-24)
Captured each surface at 390×844 via hash routes (`#inbox/#email/#more/#calendar/#notes/#settings`) using one-shot chromium screenshots (`/home/frank/ralph-shots/`).
- [x] Email list: dangling `·` separator — `mobile-surfaces.js:130` rendered `${e.from} · ${snippet}`, so an email with no body showed "Sender · " with a trailing middot. Fixed: separator now conditional on a non-empty snippet (`${snippet ? ' · '+snippet : ''}`). Verified both branches via direct import.
- [x] Top-of-list clipping on Email/Calendar (first row sliced on load). Root cause confirmed: the scroll-restore in `app.js` stuck EVERY `.m-scroll` to the bottom (the `atBottom < 80` test passes for short/empty lists, then restore set `scrollTop = scrollHeight`). Fixed: stick-to-bottom is now scoped to the chat thread (`.chat-thread` / `.m-thread`) AND requires genuine overflow (`scrollHeight - clientHeight > 4`); all other surfaces preserve their exact offset. Verified via screenshots: Email + Calendar now anchor at the true top (badges intact, no stray bleed), chat still sticks to the latest message.
- [ ] Settings pushed surface (`#settings` under More): the desktop settings tab-nav grid squeezed through `.m-pushed` orphans the "ADMIN" group label into its own grid cell and columns wrap unevenly — looks broken on phone width. Needs a mobile-specific tab-nav layout or a section dropdown. (Likely needs decision — desktop renderer reused as-is.)
