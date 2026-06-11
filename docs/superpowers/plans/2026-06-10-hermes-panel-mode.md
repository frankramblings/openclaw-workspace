# Hermes Panel Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip-launched tools open as maximized, mutually-exclusive panels with active-tab state — list tools as centered columns, width tools full-bleed — on the existing modal chassis, fully revertible via a floating-mode flag.

**Architecture:** One new overlay (`frontend-overrides/js/hermes-panels.js`) holding a classification table + visibility observer; geometry in `hermes.css`; the Chat button's close-sweep moves into the overlay and is shared. No modalManager changes, no tool rewrites, no backend.

**Tech Stack:** Vanilla JS overlay + CSS. Spec: `docs/superpowers/specs/2026-06-10-hermes-panel-mode-design.md`.

**Ground rules:** Same as the adoption plan — edit only `frontend-overrides/` + `scripts/sync-frontend.sh`; never `git add -A`; `bash scripts/sync-frontend.sh` goes live without restart; stage only your files; `// HERMES:` markers.

**Known ground truth (verified during spec/planning):**
- Windows: `#email-lib-modal` (.modal, native fullscreen = class `email-lib-fullscreen`, see emailLibrary.js:237,1204), `#calendar-modal` (created dynamically, class `modal`), `#memory-modal` (static .modal), `#inbox-panel` / `#notes-panel` / `#doc-panel` (registered panels, NOT .modal), `#cron-modal` (custom overlay, class `cron-modal-overlay`, content `.cron-modal-card`).
- Deep Research is an input-mode toggle (`#research-toggle`), NOT a windowed destination → per spec drop rule it is NOT in PANEL_SPECS (confirm nothing like `#research-modal` exists at impl: `grep -rn 'research-modal' frontend-vendor/js frontend-overrides` → expect no window; document in report).
- Strip buttons: rail-email, rail-inbox, rail-calendar, rail-documents, rail-archive (also → doc-panel), rail-notes, rail-memory, rail-tasks + rail-cron (both → cron), rail-chat-home.
- Mobile <768px: modals are bottom sheets (style.css ~6076) — all panel geometry MUST be inside `@media (min-width: 769px)`.
- The Chat button's current sweep lives in `frontend-overrides/js/hermes-footer.js` (`addChatHome`).

---

### Task 1: hermes-panels.js — table, visibility engine, closeAll, wiring

**Files:**
- Create: `frontend-overrides/js/hermes-panels.js`
- Modify: `frontend-overrides/index.html` (script tag after strip-order.js)
- Modify: `scripts/sync-frontend.sh` (injector block, same awk pattern)

- [ ] **Step 1: Create `frontend-overrides/js/hermes-panels.js`:**

```js
// HERMES: panel mode — strip-launched tools behave like Hermes panels:
// maximized into the main pane, one at a time, active tab lit on the strip.
// Pure overlay over modalManager; the tools are untouched. Escape hatch:
// localStorage['hermes-floating-windows']='1' restores classic floating
// windows wholesale (body.hermes-floating scopes every rule off).
// Spec: docs/superpowers/specs/2026-06-10-hermes-panel-mode-design.md
(function () {
  const FLOATING_KEY = 'hermes-floating-windows';

  // windowId -> treatment. mode 'full' | 'column'; width only for columns;
  // content = selector (within the window) that gets the centered column;
  // rail = strip button(s) to light when this panel is visible;
  // nativeFs = class the tool itself uses for fullscreen (preferred over
  // generic geometry when present).
  const PANEL_SPECS = {
    'email-lib-modal': { mode: 'full', rail: ['rail-email'], nativeFs: 'email-lib-fullscreen' },
    'calendar-modal':  { mode: 'full', rail: ['rail-calendar'] },
    'doc-panel':       { mode: 'full', rail: ['rail-documents', 'rail-archive'] },
    'inbox-panel':     { mode: 'column', width: 720, content: null, rail: ['rail-inbox'] },
    'notes-panel':     { mode: 'column', width: 960, content: null, rail: ['rail-notes'] },
    'memory-modal':    { mode: 'column', width: 960, content: '.modal-content', rail: ['rail-memory'] },
    'cron-modal':      { mode: 'column', width: 800, content: '.cron-modal-card', rail: ['rail-cron', 'rail-tasks'] },
  };
  // content:null = the window element itself is the column.

  const floating = () => {
    try { return localStorage.getItem(FLOATING_KEY) === '1'; } catch (e) { return false; }
  };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function setActive(visibleId) {
    document.querySelectorAll('.icon-rail-btn.hermes-active')
      .forEach((b) => b.classList.remove('hermes-active'));
    const rails = visibleId ? PANEL_SPECS[visibleId].rail : ['rail-chat-home'];
    rails.forEach((id) => document.getElementById(id)?.classList.add('hermes-active'));
  }

  // Close every classified window except `exceptId`. Registered ones via
  // modalManager (runs closeFn cleanup); cron's custom overlay via its own
  // close control; stragglers via generic close button / .hidden.
  function closeAll(exceptId) {
    return import('/static/js/modalManager.js').then((MM) => {
      Object.keys(PANEL_SPECS).forEach((id) => {
        if (id === exceptId) return;
        const el = document.getElementById(id);
        if (!el || !isVisible(el)) return;
        if (MM.isRegistered(id)) { if (!MM.isMinimized(id)) MM.close(id); return; }
        const x = el.querySelector('.close-btn, .modal-close, [data-act="close"], button[title="Close"]');
        if (x) x.click(); else el.classList.add('hidden');
      });
      // Also sweep any visible unclassified .modal that ISN'T whitelisted-
      // floating chrome — same net the Chat button used (dialogs like theme/
      // settings are left alone by checking a small floating allowlist).
      const FLOAT_OK = /^(theme-|confirm|settings|model-|preset|group)/;
      document.querySelectorAll('.modal').forEach((m) => {
        if (!m.id || PANEL_SPECS[m.id] || FLOAT_OK.test(m.id)) return;
        if (!isVisible(m)) return;
        if (MM.isRegistered(m.id)) { if (!MM.isMinimized(m.id)) MM.close(m.id); return; }
        const x = m.querySelector('.close-btn, .modal-close, button[title="Close"]');
        if (x) x.click(); else m.classList.add('hidden');
      });
    }).catch(() => {});
  }

  function applyGeometry(id, el) {
    const spec = PANEL_SPECS[id];
    if (spec.nativeFs) { el.classList.add(spec.nativeFs); return; }
    el.classList.add('hermes-panel');
    if (spec.mode === 'column') {
      el.classList.add('hermes-panel-column');
      el.style.setProperty('--hermes-panel-w', spec.width + 'px');
      const target = spec.content ? el.querySelector(spec.content) : el;
      if (target && target !== el) target.classList.add('hermes-panel-content');
      else el.classList.add('hermes-panel-content-self');
    }
  }

  let _lastVisible = null;
  function sync() {
    if (floating()) return;
    let visibleId = null;
    for (const id of Object.keys(PANEL_SPECS)) {
      const el = document.getElementById(id);
      if (el && isVisible(el)) { visibleId = id; applyGeometry(id, el); }
    }
    if (visibleId && visibleId !== _lastVisible) closeAll(visibleId);
    _lastVisible = visibleId;
    setActive(visibleId);
  }

  function init() {
    if (floating()) { document.body.classList.add('hermes-floating'); return; }
    // State-based observer: class/style flips on known windows + body
    // childList for dynamically-created ones (calendar, cron). Debounced to
    // one sync per frame.
    let raf = null;
    const kick = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; sync(); }); };
    new MutationObserver(kick).observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style'],
    });
    sync();
    window.hermesPanels = { closeAll, sync };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
```

PRE-CHECK before committing: a body-wide attribute observer firing rAF-debounced `sync()` — `sync()` must be cheap (it is: ~7 getElementById + getComputedStyle). Confirm no observer feedback loop: `applyGeometry`/`setActive` mutate classes → observer fires → sync() re-runs → classes already present, no further mutation → loop settles. `closeAll` mutates too — settles the same way. Verify by loading the page and checking CPU/console.

- [ ] **Step 2: Wire (both places).** index.html: `<script src="/static/js/hermes-panels.js" defer></script>` after the strip-order.js tag. sync-frontend.sh: sibling awk injector block (`SCRIPT_HP`, grep guard `js/hermes-panels.js`).

- [ ] **Step 3: Verify:** `node --check frontend-overrides/js/hermes-panels.js`; `bash -n scripts/sync-frontend.sh`; `bash scripts/sync-frontend.sh`; `curl -s http://localhost:8800/static/js/hermes-panels.js | grep -c PANEL_SPECS` → ≥1. Research check: `grep -rn "research-modal" frontend-vendor/js frontend-overrides | head -3` → expect nothing windowed; note in report.

- [ ] **Step 4: Commit** `git add frontend-overrides/js/hermes-panels.js frontend-overrides/index.html scripts/sync-frontend.sh && git commit -m "feat(hermes): panel-mode engine — classification, visibility sync, exclusivity, active tab"`

### Task 2: Geometry + active-tab CSS

**Files:**
- Modify: `frontend-overrides/hermes.css` (append)

- [ ] **Step 1: Append:**

```css
/* ── HERMES panel mode (desktop only; mobile keeps bottom sheets) ── */
@media (min-width: 769px) {
  body:not(.hermes-floating) .hermes-panel {
    position: fixed !important;
    top: 0 !important; right: 0 !important; bottom: 0 !important;
    left: var(--sidebar-w, 0px) !important;
    width: auto !important; height: auto !important;
    max-width: none !important; max-height: none !important;
    transform: none !important;        /* defuse drag/snap offsets */
    border-radius: 0 !important;
    margin: 0 !important;
    z-index: 200;
  }
  /* Docked/tiled states must not fight the panel */
  body:not(.hermes-floating) .hermes-panel.modal-left-docked,
  body:not(.hermes-floating) .hermes-panel.modal-right-docked {
    left: var(--sidebar-w, 0px) !important; right: 0 !important;
  }
  /* Column variant: muted backdrop, centered content column */
  body:not(.hermes-floating) .hermes-panel-column { background: var(--bg) !important; }
  body:not(.hermes-floating) .hermes-panel-column .hermes-panel-content,
  body:not(.hermes-floating) .hermes-panel-content-self {
    max-width: var(--hermes-panel-w, 860px);
    width: 100%;
    margin: 0 auto;
    height: 100%;
    background: var(--panel);
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
  }
  /* Panel chrome: no drag/resize affordances; keep ✕ and minimize */
  body:not(.hermes-floating) .hermes-panel .modal-drag-handle,
  body:not(.hermes-floating) .hermes-panel .resize-handle,
  body:not(.hermes-floating) .hermes-panel .modal-resize-handle { display: none !important; }
}
/* Active strip tab (all viewports) */
.icon-rail-btn.hermes-active {
  opacity: 1;
  background: color-mix(in srgb, var(--red) 16%, transparent);
  color: var(--red);
}
```

PRE-CHECK the chrome selectors: `grep -n "drag-handle\|resize-handle" frontend-vendor/style.css | head -5` — substitute the real handle classes used by windowDrag/modal resize (the names above are guesses; use what exists, and if drag is header-based with no dedicated handle class, instead disable via `body:not(.hermes-floating) .hermes-panel { /* windowDrag reads transform; transform:none!important already wins */ }` and note it).

- [ ] **Step 2: Build + eyeball on desktop** (1440px): open each of the 7 panels from the strip — Email/Calendar/Documents full-bleed; Inbox 720 / Cron 800 / Notes 960 / Memory 960 centered columns on muted backdrop; exclusivity (opening one closes the previous); exactly one lit strip icon; Chat tab clears and lights chat-home. Adjust column widths ±15% where a tool's internal split clearly wants it; record finals in PANEL_SPECS comments.

- [ ] **Step 3: Commit** `git add frontend-overrides/hermes.css frontend-overrides/js/hermes-panels.js && git commit -m "feat(hermes): panel geometry + active-tab CSS (per-tool column widths finalized)"`

### Task 3: Chat button uses the shared sweep; footer refactor

**Files:**
- Modify: `frontend-overrides/js/hermes-footer.js`

- [ ] **Step 1:** Replace the `addChatHome` click handler's inline sweep with:

```js
      b.addEventListener('click', () => {
        if (window.hermesPanels) { window.hermesPanels.closeAll(); return; }
        // Fallback (panel overlay absent/floating mode): previous inline sweep.
        import('/static/js/modalManager.js').then((MM) => {
          document.querySelectorAll('.modal').forEach((m) => {
            if (!m.id) return;
            const cs = getComputedStyle(m);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            if (MM.isRegistered(m.id)) { if (!MM.isMinimized(m.id)) MM.close(m.id); return; }
            const x = m.querySelector('.close-btn, .modal-close, button[title="Close"]');
            if (x) x.click(); else m.classList.add('hidden');
          });
          ['notes-panel', 'doc-panel', 'inbox-panel'].forEach((id) => {
            try { if (MM.isRegistered(id) && !MM.isMinimized(id)) MM.close(id); } catch (e) {}
          });
        }).catch(() => {});
      });
```

(Note: `window.hermesPanels` is undefined when floating mode disabled the overlay — the fallback IS the floating-mode behavior. Intentional.)

- [ ] **Step 2:** `node --check`, build, verify Chat click still closes an open calendar; commit `fix(hermes): chat tab delegates to shared panel sweep`.

### Task 4: Mobile + floating-flag + chip smoke, wrap

- [ ] **Step 1: Mobile check** (≤768px window or device): open Email, Inbox, Calendar — bottom sheets identical to before (no `.hermes-panel` geometry — it's media-scoped), one at a time (exclusivity active), strip active states correct in the drawer.
- [ ] **Step 2: Floating flag:** in devtools `localStorage.setItem('hermes-floating-windows','1')` + reload → windows float/drag/dock exactly as before this feature; chat button fallback sweep still works. Clear the flag.
- [ ] **Step 3: Chip round-trip:** minimize Email from panel mode → chip; restore → re-enters panel mode (observer re-applies). 
- [ ] **Step 4:** Note results in the commit body; `git commit --allow-empty -m "test(hermes): panel-mode smoke — desktop/mobile/floating/chips" ` only if no code changed, else commit the fixes with their own messages.
- [ ] **Step 5:** Update `docs/superpowers/specs/2026-06-10-hermes-panel-mode-design.md` status line to "Shipped <date>" and memory file `project_hermes_ui_adoption.md` with a panel-mode paragraph. Commit.

---

## Self-review notes
- Spec coverage: classification/table → T1; geometry+widths+active → T2; shared sweep/chat → T3; mobile/floating/chips acceptance → T4. Research dropped per spec rule (verified: input toggle, not a window). Sidebar-body swap: explicit non-goal, no task.
- Placeholders: chrome-handle selectors are flagged as MUST-VERIFY with a concrete fallback, not left vague; column widths carry the ±15% finalize rule from the spec.
- Type consistency: `closeAll(exceptId?)` returns a promise (used fire-and-forget); `window.hermesPanels = { closeAll, sync }` matches T3's usage.
