# Email Modal — Desktop Two-Pane Reader (plan addendum)

> Extends `2026-06-16-email-tab-triage-focused.md`. Branch `email-triage-focused`, worktree `/Users/admin/openclaw-workspace/.worktrees/email-triage-focused`.

**Goal:** On wide desktop windows (≥1100px), the email modal shows the card list as a left column with a persistent **reading pane** on the right; clicking a row renders the message there (no accordion push). Below 1100px and on mobile, today's inline-expand reader is unchanged.

**Grounding (verified 2026-06-16):**
- Modal content: `<div class="modal-content doclib-modal-content" style="width:min(720px, 92vw);max-height:85vh;…">` (`emailLibrary.js:587`). **Too narrow for two columns → two-pane must widen the modal.**
- Card grid container `#email-lib-grid` (`:666`) inside the modal content.
- `_toggleCardPreview(card, em)` (`:1953`) = the inline-expand reader: collapses other expanded cards, adds `.email-card-expanded`, builds a `.email-card-reader` element (`:2010`) **inside the card**, fetches `/api/email/read/{uid}`, renders body via `_safeRenderEmailBody`/`_renderEmailBody`.
- Reader DOM is already reused by the "Open in new tab" modal (`:3612`+, mounts `.email-card-reader`).
- Reply/Forward open the doc editor pane (left-snap) — **left unchanged** in v1.
- Shared pure logic: `frontend-overrides/js/emailLibrary/triageLogic.js` (tested by `scripts/test-email-triage-math.mjs`).

**Decision:** breakpoint = 1100px (constant `EMAIL_TWO_PANE_MIN`). Mobile (`< 768`, `pointer: coarse`) never two-panes. Reply flow unchanged.

---

## Task TP1: `triageMode(width)` helper (TDD)

**Files:** `frontend-overrides/js/emailLibrary/triageLogic.js`, `scripts/test-email-triage-math.mjs`.

- [ ] **Step 1 (RED):** Add to `scripts/test-email-triage-math.mjs` (import `triageMode` and assert): `triageMode(1200)==='split'`, `triageMode(1100)==='split'`, `triageMode(1099)==='stack'`, `triageMode(375)==='stack'`. Add `triageMode` to the import line. Run → FAIL.
- [ ] **Step 2 (GREEN):** Add to `triageLogic.js`:
```js
export const EMAIL_TWO_PANE_MIN = 1100;   // px — at/above this the reader pane shows
export function triageMode(width) {
  return width >= EMAIL_TWO_PANE_MIN ? 'split' : 'stack';
}
```
Run the node test → PASS.
- [ ] **Step 3:** Commit (`test(email): triageMode breakpoint helper`).

## Task TP2: Layout scaffold (pane + widened modal + mode toggle, NO behavior change yet)

**Files:** `frontend-overrides/js/emailLibrary.js`, `frontend-overrides/workspace.css`.

- [ ] **Step 1:** Import `triageMode` (and `EMAIL_TWO_PANE_MIN` if useful) from `./emailLibrary/triageLogic.js` (extend the existing triageLogic import).
- [ ] **Step 2:** In `openEmailLibrary`'s modal HTML, wrap the grid + a new reader pane so they can sit side by side. Minimal approach: keep `#email-lib-grid` where it is, and add a sibling `<div id="email-lib-reader-pane" class="email-lib-reader-pane" hidden></div>` immediately after it, with a shared parent that can be a flex row. If `#email-lib-grid` already has a scroll parent, add the pane as its sibling and give the parent `id="email-lib-listpane-wrap"` if it lacks one.
- [ ] **Step 3:** Add `_applyEmailTwoPane()`:
```js
function _applyEmailTwoPane() {
  const modal = document.getElementById('email-lib-modal');
  if (!modal) return;
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  const on = !coarse && triageMode(window.innerWidth) === 'split';
  modal.classList.toggle('email-two-pane', on);
  if (!on) {
    const pane = document.getElementById('email-lib-reader-pane');
    if (pane) { pane.hidden = true; pane.innerHTML = ''; }
    _emailReaderUid = null;
  }
}
```
Declare `let _emailReaderUid = null;` near the other module state. Call `_applyEmailTwoPane()` at the end of `openEmailLibrary` (after the modal is in the DOM), and add one `window.addEventListener('resize', _applyEmailTwoPane)` (guard against double-binding with a module flag like the file does elsewhere).
- [ ] **Step 4:** CSS — append to `workspace.css`:
```css
/* Email modal: desktop two-pane reader ------------------------------------ */
#email-lib-modal.email-two-pane .doclib-modal-content { width: min(1200px, 95vw); }
#email-lib-modal.email-two-pane #email-lib-listpane-wrap { display: flex; gap: 0; min-height: 0; flex: 1; }
#email-lib-modal.email-two-pane #email-lib-grid { flex: 0 0 38%; max-width: 420px; overflow-y: auto; border-right: 1px solid var(--border, rgba(127,127,127,0.2)); }
#email-lib-modal.email-two-pane #email-lib-reader-pane { flex: 1 1 auto; overflow-y: auto; min-width: 0; }
#email-lib-modal.email-two-pane #email-lib-grid .doclib-card.email-row-active { background: var(--hover, rgba(127,127,127,0.14)); }
.email-lib-reader-pane { padding: 0 4px; }
.email-lib-reader-pane .email-reader-empty { opacity: 0.5; text-align: center; padding: 40px 12px; font-size: 13px; }
```
- [ ] **Step 5:** Verify `node --check` + node test still pass. Commit (`feat(email): two-pane scaffold — reader pane + widened modal + mode toggle`).

(After TP2 the pane exists/toggles but is empty — no reading behavior change. Verify the modal still looks/works normally below 1100px and on mobile.)

## Task TP3: Route reading into the pane (factor `_buildReaderInto`)

**Files:** `frontend-overrides/js/emailLibrary.js`.

- [ ] **Step 1: Factor the reader build.** Read `_toggleCardPreview` (`:1953`) carefully. Extract the part that (a) fetches `/api/email/read/{uid}` and (b) builds the `.email-card-reader` content (header/actions/body via `_safeRenderEmailBody`) into a reusable `async function _buildReaderInto(container, em)` that fills `container` with a fresh `.email-card-reader` and renders the message. Keep `_toggleCardPreview` working by having its inline path call `_buildReaderInto(card-inner-container, em)` for the body build — OR, if extraction is too coupled, the SAFER minimal version: leave `_toggleCardPreview` as-is for the inline path, and write `_buildReaderInto` as a parallel function that reuses the same lower-level helpers (`_safeRenderEmailBody`, the same fetch URL, the same action-button builder). Prefer reuse; if duplicating, duplicate only the small reader-shell assembly, NOT the fetch or body renderer. Report which path you took.
- [ ] **Step 2: Route row clicks by mode.** Find the card click handler that calls `_toggleCardPreview(card, em)` (the row-body click, ~`:1860`). Wrap it:
```js
if (document.getElementById('email-lib-modal')?.classList.contains('email-two-pane')) {
  _openInReaderPane(em, card);
} else {
  _toggleCardPreview(card, em);
}
```
- [ ] **Step 3: Add `_openInReaderPane(em, card)`:**
```js
async function _openInReaderPane(em, card) {
  const pane = document.getElementById('email-lib-reader-pane');
  if (!pane) return;
  pane.hidden = false;
  const grid = document.getElementById('email-lib-grid');
  grid?.querySelectorAll('.doclib-card.email-row-active').forEach(c => c.classList.remove('email-row-active'));
  if (card) card.classList.add('email-row-active');
  _emailReaderUid = String(em.uid);
  pane.innerHTML = '<div class="email-reader-empty">Loading…</div>';
  await _buildReaderInto(pane, em);
}
```
- [ ] **Step 4: Empty state.** When the pane is shown with nothing selected (e.g. after `_applyEmailTwoPane` turns it on), show `<div class="email-reader-empty">Select an email to read</div>`. Set this in `_applyEmailTwoPane` when turning two-pane ON and `_emailReaderUid` is null.
- [ ] **Step 5: Prev/next + arrow keys in two-pane.** The modal already has prev/next nav (arrows in the expanded reader, and an arrow-key handler ~the `_libEmails` order). In two-pane mode, prev/next should select the adjacent card in `state._libEmails` and call `_openInReaderPane`. Find the existing nav (search `ArrowDown`/`ArrowUp` or the reader nav arrows) and, when `.email-two-pane` is active, route it to move `_emailReaderUid` to the prev/next email in `state._libEmails` and re-open in the pane. Keep the inline path's existing nav for narrow mode.
- [ ] **Step 6:** Verify `node --check` + node test. Manually reason through: opening the modal ≥1100px shows list+empty-pane; clicking a row fills the pane and highlights the row; clicking another swaps it; resizing below 1100px reverts to inline-expand with the pane hidden; mobile unaffected. Commit (`feat(email): route reading into the desktop two-pane pane`).

## Verification (after TP3)
- `node --check frontend-overrides/js/emailLibrary.js`, `node scripts/test-email-triage-math.mjs`.
- Full sync byte-smoke: `WORKSPACE_BUILD_DEST=/tmp/fe-smoke ODYSSEUS_STATIC=frontend-vendor bash scripts/sync-frontend.sh` → `node --check /tmp/fe-smoke/js/emailLibrary.js`; `rm -rf /tmp/fe-smoke`.
- Deploy stays user-gated (sync + restart, eyeball on :8443 at a wide and a narrow window).

## Guardrails
- Below 1100px and on touch: ZERO behavior change. The inline-expand reader (`_toggleCardPreview`), swipe nav, and reply/doc-pane flow must work exactly as before.
- Reuse `_safeRenderEmailBody` + the existing fetch — do not duplicate body rendering or sanitization.
- Don't widen the modal except via the `.email-two-pane` class.
