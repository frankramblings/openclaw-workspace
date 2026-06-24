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

## Tooling
- Surfaces unreachable by URL hash (email **reader**, **companion**/**capture** sheets) can be screenshotted via `/home/frank/ralph-shots/harness.mjs` — it imports the real renderers, emits standalone HTML linking the LIVE served `redesign.css` + `mobile.css`, and chromium screenshots the `file://`. Set any state field (e.g. `emailSummary`) to exercise conditional branches.

## Done
- [x] Kill grey iOS tap-flash + press-in scale on small controls (`mobile.css:17-25`) — with reduced-motion guard.
- [x] Composer focus transition + send button dims/inert until text typed (`mobile.css:100-110`).
- [x] Large tap targets (`.m-mail`, `.m-grid-card`, companion handle pill) lost tap feedback when the native highlight was killed — added background-settle on `:active` (`mobile.css:26-30`).
- [x] Chat empty/new-thread rendered a fully blank screen — added centered `.m-chat-zero` prompt ("Message Gary to start") reusing the shared `.inbox-zero` shell (`mobile-surfaces.js` mChat, `mobile.css` `.m-thread.empty`). New chats (`live/chat.js:801,816` set `thread=[]`) now get a friendly placeholder instead of void. Verified both branches render via direct import.

## Backlog (concrete, observed)
- [x] Dead decorative controls with `cursor:pointer` but no `data-act` — ALL RESOLVED. email reader `✦ Summarize` → `summarizeEmail` + inline `.m-email-summary`; `✦ AI reply` + reply-bar `✦ Draft` → `composeAiDraft`; reply box + send → `composeReply` (via new mobile compose sheet `renderComposeSheet`, bound to sendEmail/closeCompose). `.m-gary-card` (More hub) → made STATIC per Frank: dropped the chevron + `cursor:pointer` so it reads as a status display, not a button. Calendar `Day` seg → dropped the dead "Day" pill per Frank (only Agenda exists); the seg now shows a single "Agenda" indicator. Verified live via screenshots.
- [x] `.m-tab-badge` hardcoded `right: calc(50% - 19px)` — VERIFIED OK via cropped screenshot. It's anchored to tab-center (50%) and the icon is centered too, so the badge sits correctly on the inbox icon's top-right regardless of tab/label width. Not fragile. No change.
- [x] Quick-add `+` button (`data-act="clearQuick"`) — VERIFIED OK. `clearQuick` is overridden in `live/calendar.js:320` to parse the natural-language text and POST a calendar event; the mock's `state.quick=''` is only the no-backend fallback. So `+` = add (matches desktop's "↵ Add"). The name is a misnomer but behavior is correct. No change.
- [x] Email reader archive/dots `border:none` — VERIFIED OK via harness screenshot. The borderless reader toolbar reads clean and intentional (back-text + two quiet icon glyphs); adding borders would look heavier/worse. Leave as-is.
- [x] `.m-mail.active` only highlighted when `e.unread` was truthy (`mobile-surfaces.js:127`) — a read, selected email showed no active state. Fixed: highlight on selection (`i === s.selEmail`) regardless of unread.
- [x] Reduced-motion: sheet slide-up (`m-sheet-up`), status-dot `pulse` (both `.m-gary .status .dot` and `.m-gary-card .st .dot`), and terminal-cursor `blink` are now disabled under `prefers-reduced-motion`. The pull-to-refresh `spin` is intentionally kept — it conveys progress; freezing it reads as broken.
- [x] `:focus-visible` ring added (`.m-app button/textarea/input:focus-visible` → 2px teal outline, 2px offset). Scoped to keyboard/switch focus so it never shows on tap (pointer presses use `:active`). Proven with an autofocus harness: focused control shows the ring, others don't.
- [ ] `.m-tab-badge` position uses a hardcoded `right: calc(50% - 19px)` (`mobile.css:68`) — fragile if label width changes; verify it sits correctly over each tab icon.
- [ ] Quick-add calendar button is `data-act="clearQuick"` showing a `+` (`mobile-surfaces.js:178`) — a plus glyph that clears reads wrong; confirm icon vs. action intent.
- [x] Email reader archive/dots `border:none` — resolved above (verified intentional/clean via harness screenshot).

## Found via narrow-viewport (320px) sweep (2026-06-24)
- [x] Inbox cards showed raw markdown markers in previews (e.g. an Obsidian item rendered `**Schedule paid media…**` literally, asterisks and all) — `it.who`/`it.body` are plain-`esc`'d. Added a conservative `stripMd()` helper (dom.js) that unwraps `**`/`__`/`` ` ``/`[text](url)`/leading `#`/bullets and collapses whitespace for one-line previews, applied to both inbox card title + body. Verified: Obsidian card now reads "Schedule paid media strategy sync … (Allie)" cleanly. `stripMd('3*4=12')` left intact (no false strips).
- [x] Swept chat/inbox/email at 320px (iPhone SE width) — no overflow or control cramping; composer (attach+textarea+mic+send) and cards all fit. Markdown chat renders fine. (Note: chat is the heaviest surface to load — needs ~10-11s virtual-time-budget to screenshot, else captures blank mid-load; not a bug.)

## Found via post-feature sweep (2026-06-24)
- [x] Email list showed a prominent teal `.m-mail.active` border on the FIRST row on fresh load (default `selEmail:0`) — misleading on mobile, which is single-pane (tap → full reader), so there's no persistent list selection to advertise. Fixed: gate the highlight on a new `s.mEmailOpened` flag (set in `mOpenReader`), so nothing is highlighted until the user opens a reader; on return it marks the last-read row. Verified: fresh load uniform, post-open highlight present.
- [x] Verified the new scroll-to-bottom button (`.m-scroll-btm`) is wired for mobile (`scrollChatBottom` now targets `.chat-thread, .m-thread`; scroll listener gates on those classes only — no misfire on email/inbox/calendar `.m-scroll`).
- [x] Verified markdown rendering in mobile chat (`.m-md`: headings/list/blockquote/inline-code/links) + focused composer (attach+textarea+send, no mic) render cleanly via live + harness screenshots.

## Found via mobile screenshot survey (2026-06-24)
Captured each surface at 390×844 via hash routes (`#inbox/#email/#more/#calendar/#notes/#settings`) using one-shot chromium screenshots (`/home/frank/ralph-shots/`).
- [x] Email list: dangling `·` separator — `mobile-surfaces.js:130` rendered `${e.from} · ${snippet}`, so an email with no body showed "Sender · " with a trailing middot. Fixed: separator now conditional on a non-empty snippet (`${snippet ? ' · '+snippet : ''}`). Verified both branches via direct import.
- [x] Top-of-list clipping on Email/Calendar (first row sliced on load). Root cause confirmed: the scroll-restore in `app.js` stuck EVERY `.m-scroll` to the bottom (the `atBottom < 80` test passes for short/empty lists, then restore set `scrollTop = scrollHeight`). Fixed: stick-to-bottom is now scoped to the chat thread (`.chat-thread` / `.m-thread`) AND requires genuine overflow (`scrollHeight - clientHeight > 4`); all other surfaces preserve their exact offset. Verified via screenshots: Email + Calendar now anchor at the true top (badges intact, no stray bleed), chat still sticks to the latest message.
- [x] Settings pushed surface (`#settings` under More): the desktop tab-nav squeezed through `.m-pushed` (flex-wrap) orphaned the "ADMIN" group label mid-row and dividers vanished. Fixed CSS-only: `.m-pushed .set-nav-label` / `.set-nav-div` are now `flex-basis:100%` so each group label is a full-width subheading and each divider a full-width rule, with items wrapping cleanly beneath. Verified via screenshot (note: pushed surfaces load live data — needs ~9s virtual-time-budget to capture, not 6s).
- [x] Swept the other pushed surfaces (Research, Library) — both render cleanly in the single-column `.m-pushed` wrapper (mode chips/defaults wrap fine; lib-grid is 2-col). No seams.
