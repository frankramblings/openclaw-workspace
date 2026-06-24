# Mobile UI polish — Ralph backlog

Task: iterative polish passes on the mobile redesign shell to fix many small
issues. Mobile surface lives in `frontend-overrides/js/redesign/mobile/`
(`mobile.css`, `mobile-app.js`, `mobile-surfaces.js`, `mobile-sheets.js`,
`mobile-data.js`). `frontend-overrides/` is the deployed snapshot we edit directly.

## Loop protocol (one coherent item per iteration)
1. Read this file. Pick the top `[ ]` item.
2. Investigate at `file:line`. Fix if contained (≤ ~1 file, no design decision); else add a `needs human:` note and mark `[!]`.
3. Run `node --test 'frontend-overrides/js/__tests__/*.test.js'` (must stay green — 53 tests).
4. Mark the item `[x]`/`[!]`, append a PROGRESS line, commit `mobile: <one-line>`, exit.

CSS-only changes aren't covered by the node tests (renderers only) — Frank verifies in-browser.

## Done
- [x] Kill grey iOS tap-flash + press-in scale on small controls (`mobile.css:17-25`) — with reduced-motion guard.
- [x] Composer focus transition + send button dims/inert until text typed (`mobile.css:100-110`).
- [x] Large tap targets (`.m-mail`, `.m-grid-card`, companion handle pill) lost tap feedback when the native highlight was killed — added background-settle on `:active` (`mobile.css:26-30`).

## Backlog (concrete, observed)
- [ ] Dead decorative controls with `cursor:pointer` but no `data-act`: email reader `✦ AI reply` / `✦ Summarize` (`mobile-surfaces.js:152`), `✦ Draft` + reply send button (`:156`), `.m-gary-card` in More hub (`:186`), calendar `Day/Agenda` seg (`:172`). Either wire them or drop the pointer affordance so they don't promise interactivity. — needs decision on wiring vs. stub.
- [ ] `.m-mail.active` only highlights when `e.unread` is truthy (`mobile-surfaces.js:127`) — a read, selected email shows no active state. Confirm intended; likely should highlight on selection regardless of unread.
- [ ] Reduced-motion: sheet slide-up (`@keyframes m-sheet-up`, `mobile.css:228-229`) and pulse/blink dot animations aren't disabled under `prefers-reduced-motion`. Add guards.
- [ ] No `:focus-visible` styling anywhere in mobile.css — keyboard/switch-control users get no focus ring on buttons/tabs.
- [ ] `.m-tab-badge` position uses a hardcoded `right: calc(50% - 19px)` (`mobile.css:68`) — fragile if label width changes; verify it sits correctly over each tab icon.
- [ ] Quick-add calendar button is `data-act="clearQuick"` showing a `+` (`mobile-surfaces.js:178`) — a plus glyph that clears reads wrong; confirm icon vs. action intent.
- [ ] Email reader archive/dots icon buttons (`mobile-surfaces.js:146-147`) have `border:none` inline override — inconsistent with `.m-icon-btn` elsewhere; confirm intentional.
