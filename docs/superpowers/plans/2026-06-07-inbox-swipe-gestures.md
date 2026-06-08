# Inbox Swipe Triage (iOS-style, mobile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iOS-Mail-faithful swipe gestures on Inbox cards (mobile only): right swipe → ✨ rec/primary action, left swipe → Snooze | Dismiss zones, with 1:1 tracking, rubber-banding, flick commits, and spring snap-back.

**Architecture:** All code in `frontend-overrides/js/inbox.js` (a marked SWIPE section — NO new script file; a new file would need an index.html tag, the trap that once made the tab invisible) + CSS in `frontend-overrides/workspace.css`. Pure gesture math sits between `/* SWIPE-MATH-BEGIN */`…`/* SWIPE-MATH-END */` markers so a node script can extract and assert it. Cards gain an `.inbox-swipe-content` wrapper that translates over absolutely-positioned `.swipe-under` zone layers. Commits route through the existing `doAction`/`handToGary` paths (undo toast, history, counters all free). Spec: `docs/superpowers/specs/2026-06-07-inbox-swipe-gestures-design.md`.

**Tech Stack:** Pointer Events (capture + direction lock), CSS `transform: translate3d` + `cubic-bezier` springs, `touch-action: pan-y`, `matchMedia('(pointer: coarse)')` gating. No libraries, no build step.

**Conventions for every task:**
- CONCURRENT SESSIONS work in this repo. Before editing a file, `git status --short <file>` — dirty → STOP, report BLOCKED. Stage explicit paths only; never `git add -A`.
- `frontend/` is gitignored + rsync-clobbered; canonical files live in `frontend-overrides/`, mirrored by `cp`. Static files are served from disk per request — NO launchd restart is needed for JS/CSS-only changes (don't restart; the 8GB host hates it).
- After every inbox.js edit: `node --check frontend-overrides/js/inbox.js`, then `cp frontend-overrides/js/inbox.js frontend/js/inbox.js` (and same for workspace.css when touched), then verify serve: `curl -s http://127.0.0.1:8800/static/js/inbox.js | grep -c <new-symbol>`.
- Current inbox.js is 432 lines: `cardHtml` ~141-168 (card markup), `bindCard` ~171-205 (button + chip handlers), `doAction` ~207-230, `snoozeMenu` ~232-246, `handToGary` ~266+, state decl ~43, `render()` ~106. Line numbers drift — anchor on the quoted code, not numbers.

---

### Task 1: Pure gesture math + node assert script

**Files:**
- Modify: `frontend-overrides/js/inbox.js` (insert the SWIPE-MATH block after the `SNOOZES` constant)
- Create: `scripts/test-swipe-math.mjs`
- Mirror: `cp` inbox.js into `frontend/js/`

- [ ] **Step 1: Write the failing assert script**

Create `scripts/test-swipe-math.mjs`:

```javascript
// Extract the marked pure-math block from inbox.js and assert its behavior.
// No test runner exists for frontend code; this is the next best thing and
// runs in CI-less reality via: node scripts/test-swipe-math.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../frontend-overrides/js/inbox.js', import.meta.url), 'utf8');
const m = src.match(
  /\/\* SWIPE-MATH-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* SWIPE-MATH-END \*\//);
if (!m) { console.error('FAIL: SWIPE-MATH markers not found'); process.exit(1); }
const fns = new Function(
  m[1] + '; return { SWIPE, swipeRubber, swipeVelocity, swipeOutcome };')();

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL: ' + msg); failures++; }
};

// --- swipeRubber ------------------------------------------------------------
assert(fns.swipeRubber(50, 88) === 50, 'no resistance under max reveal');
assert(fns.swipeRubber(188, 88) === 88 + 100 * fns.SWIPE.RUBBER,
       'resistance past max');
assert(fns.swipeRubber(-188, 88) === -(88 + 100 * fns.SWIPE.RUBBER),
       'resistance symmetric on the left');
assert(fns.swipeRubber(0, 88) === 0, 'zero is zero');

// --- swipeVelocity ----------------------------------------------------------
assert(fns.swipeVelocity([{ x: 0, t: 0 }, { x: 60, t: 100 }]) === 0.6,
       'velocity = dx/dt px/ms');
assert(fns.swipeVelocity([{ x: 0, t: 0 }]) === 0, 'single sample -> 0');
assert(fns.swipeVelocity([]) === 0, 'no samples -> 0');
assert(fns.swipeVelocity([{ x: 0, t: 5 }, { x: 9, t: 5 }]) === 0,
       'zero dt cannot divide');
assert(fns.swipeVelocity([{ x: 100, t: 0 }, { x: 40, t: 100 }]) === -0.6,
       'leftward velocity is negative');

// --- swipeOutcome (card width 360 -> commit distance 216) -------------------
assert(fns.swipeOutcome(220, 0, 360) === 'commit', 'distance commit');
assert(fns.swipeOutcome(-220, 0, 360) === 'commit', 'left distance commit');
assert(fns.swipeOutcome(120, 0.7, 360) === 'commit', 'rightward flick commits');
assert(fns.swipeOutcome(-120, -0.7, 360) === 'commit', 'leftward flick commits');
assert(fns.swipeOutcome(120, -0.7, 360) === 'reveal',
       'flick against the offset does NOT commit');
assert(fns.swipeOutcome(8, 0.9, 360) === 'rest',
       'flick within the lock distance is noise');
assert(fns.swipeOutcome(60, 0, 360) === 'reveal', 'past half a zone -> reveal');
assert(fns.swipeOutcome(-60, 0, 360) === 'reveal', 'left reveal');
assert(fns.swipeOutcome(30, 0, 360) === 'rest', 'short drag rests');

if (failures) { console.error(`${failures} assert(s) failed`); process.exit(1); }
console.log('swipe-math: all asserts passed');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/test-swipe-math.mjs`
Expected: `FAIL: SWIPE-MATH markers not found`, exit 1.

- [ ] **Step 3: Add the math block to inbox.js**

In `frontend-overrides/js/inbox.js`, directly AFTER the `SNOOZES = () => {...};` constant (before the `let _modal = ...` state declaration), insert:

```javascript
  /* SWIPE-MATH-BEGIN (pure — node-tested by scripts/test-swipe-math.mjs) */
  const SWIPE = {
    LOCK_PX: 10,          // movement before direction lock
    ZONE_W: 88,           // px per revealed action zone
    COMMIT_RATIO: 0.6,    // fraction of card width = full-swipe commit
    FLICK_VMIN: 0.6,      // px/ms — flick commits regardless of distance
    RUBBER: 0.5,          // resistance factor past max reveal
    SNAP_MS: 280,
    SNAP_EASE: 'cubic-bezier(0.25, 1, 0.5, 1)',
  };

  function swipeRubber(rawX, maxReveal) {
    const ax = Math.abs(rawX);
    if (ax <= maxReveal) return rawX;
    return Math.sign(rawX) * (maxReveal + (ax - maxReveal) * SWIPE.RUBBER);
  }

  function swipeVelocity(samples) {   // [{x, t}, ...] oldest first
    if (samples.length < 2) return 0;
    const a = samples[0], b = samples[samples.length - 1];
    const dt = b.t - a.t;
    return dt > 0 ? (b.x - a.x) / dt : 0;
  }

  function swipeOutcome(x, v, cardWidth) {
    const ax = Math.abs(x);
    if (ax >= cardWidth * SWIPE.COMMIT_RATIO) return 'commit';
    if (Math.abs(v) >= SWIPE.FLICK_VMIN && Math.sign(v) === Math.sign(x)
        && ax > SWIPE.LOCK_PX) return 'commit';
    if (ax >= SWIPE.ZONE_W * 0.5) return 'reveal';
    return 'rest';
  }
  /* SWIPE-MATH-END */
```

- [ ] **Step 4: Run the asserts + syntax check, mirror**

```bash
cd ~/openclaw-workspace
node scripts/test-swipe-math.mjs        # expect: swipe-math: all asserts passed
node --check frontend-overrides/js/inbox.js
cp frontend-overrides/js/inbox.js frontend/js/inbox.js
```

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/inbox.js scripts/test-swipe-math.mjs
git commit -m "feat(inbox): swipe gesture math — constants, rubber-band, velocity, outcome (node-asserted)"
```

---

### Task 2: Zone layers + content wrapper (visual structure, inert)

**Files:**
- Modify: `frontend-overrides/js/inbox.js` (`cardHtml` + a `zoneHtml` helper)
- Modify: `frontend-overrides/workspace.css` (restructure `.inbox-item` rules + new swipe CSS)
- Mirror both.

- [ ] **Step 1: Add `zoneHtml` and wrap the card content**

In `frontend-overrides/js/inbox.js`, add directly BEFORE `function cardHtml(it)`:

```javascript
  // Per-card swipe under-layers (spec §2). Right swipe reveals the LEFT layer
  // (one zone: ✨ rec action when present, else the static primary); left
  // swipe reveals the RIGHT layer (Snooze | Dismiss, Dismiss outermost).
  // Inert on desktop: display:none outside (pointer: coarse).
  const SWIPE_ACTIONS = ['archive', 'delete', 'mark_read', 'complete',
                         'reviewed', 'reply', 'gary'];
  function zoneHtml(it) {
    const rec = it.rec && SWIPE_ACTIONS.includes(it.rec.action) ? it.rec : null;
    const [pAct, pLabel] = PRIMARY[it.source] || ['dismiss', 'Done'];
    const right = rec
      ? { act: rec.action, label: '✨ ' + (REC_LABELS[rec.action] || rec.action),
          cls: 'swipe-zone-rec' }
      : { act: pAct, label: pLabel, cls: 'swipe-zone-primary' };
    return (
      `<div class="swipe-under swipe-under-left ${right.cls}" data-act="${esc(right.act)}">` +
      `<span class="swipe-zone-label">${esc(right.label)}</span></div>` +
      `<div class="swipe-under swipe-under-right">` +
      `<button class="swipe-zone swipe-zone-snooze" data-zone="snooze">Snooze</button>` +
      `<button class="swipe-zone swipe-zone-dismiss" data-zone="dismiss">Dismiss</button>` +
      `</div>`);
  }
```

Then in `cardHtml(it)`, wrap the existing content. The current return is:

```javascript
    return (
      `<div class="inbox-item" data-id="${esc(it.id)}" data-src="${esc(it.source)}">` +
      `  <div class="inbox-item-main">` +
      ...
      `  </div>` +
      `  <div class="inbox-item-actions">` +
      ...
      `  </div>` +
      `</div>`);
```

Change ONLY the shell (the `...` interior stays byte-identical):

```javascript
    return (
      `<div class="inbox-item" data-id="${esc(it.id)}" data-src="${esc(it.source)}">` +
      zoneHtml(it) +
      `<div class="inbox-swipe-content">` +
      `  <div class="inbox-item-main">` +
      ...
      `  </div>` +
      `  <div class="inbox-item-actions">` +
      ...
      `  </div>` +
      `</div>` +
      `</div>`);
```

- [ ] **Step 2: Restructure the card CSS**

In `frontend-overrides/workspace.css`, the existing rule is:

```css
.inbox-item {
  display: flex; align-items: flex-start; gap: 10px; position: relative;
  padding: 10px 12px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.07));
}
```

Replace it with (flex/padding move INTO the wrapper so desktop renders identically):

```css
.inbox-item {
  position: relative;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.07));
}
.inbox-swipe-content {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px; position: relative; z-index: 1;
}
```

In the mobile media query at the end of the original inbox block, change
`.inbox-item { flex-direction: column; }` to
`.inbox-swipe-content { flex-direction: column; }` (the
`.inbox-item-actions { align-self: flex-end; }` line stays).

Then APPEND the swipe block at the end of the file:

```css
/* --- Inbox swipe triage (mobile; added by inbox.js SWIPE section) --------- */
.swipe-under { display: none; }
@media (pointer: coarse) {
  .inbox-item { touch-action: pan-y; overflow: hidden; }
  .inbox-swipe-content {
    background: var(--panel, #14181f);   /* opaque so zones don't bleed through */
    will-change: transform;
  }
  .swipe-under {
    position: absolute; inset: 0; display: flex; align-items: center;
    visibility: hidden;
  }
  .swipe-under-left  { justify-content: flex-start; padding-left: 18px; }
  .swipe-under-right { justify-content: flex-end; background: #dc2f4e; }
  .swipe-zone-rec     { background: rgba(154, 120, 230, 0.95); }
  .swipe-zone-primary { background: rgba(86, 130, 222, 0.95); }
  .swipe-zone-label   { font-size: 13px; font-weight: 600; color: #fff;
                        transition: transform 120ms ease-out; }
  .swipe-zone {
    border: none; height: 100%; width: 88px; font-size: 12.5px;
    font-weight: 600; color: #fff; cursor: pointer;
  }
  .swipe-zone-snooze  { background: #c77d10; transition: opacity 120ms; }
  .swipe-zone-dismiss { background: #dc2f4e; }
  .swipe-armed .swipe-zone-label  { transform: scale(1.15); }
  .swipe-armed .swipe-zone-snooze { opacity: 0; }  /* iOS: armed zone takes over */
}
@media (prefers-reduced-motion: reduce) {
  .swipe-zone-label, .swipe-zone-snooze { transition: none; }
}
```

- [ ] **Step 3: Verify structure**

```bash
cd ~/openclaw-workspace
node scripts/test-swipe-math.mjs && node --check frontend-overrides/js/inbox.js
cp frontend-overrides/js/inbox.js frontend/js/inbox.js
cp frontend-overrides/workspace.css frontend/workspace.css
curl -s http://127.0.0.1:8800/static/js/inbox.js | grep -c 'swipe-under'   # >=2
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --no-sandbox --virtual-time-budget=8000 --dump-dom \
  http://127.0.0.1:8800/ 2>/dev/null > /tmp/swipe_dom.html || true
```

Headless note: the modal only builds on click, so the DOM dump won't contain
cards — the meaningful check is desktop visual parity. Verify with:
`grep -c 'inbox-swipe-content' frontend/js/inbox.js` (≥2: zoneHtml + cardHtml)
and eyeball `http://127.0.0.1:8800` on the Mac (cards must look unchanged —
the wrapper carries the old flex layout; zones are display:none on fine
pointers).

- [ ] **Step 4: Commit**

```bash
git add frontend-overrides/js/inbox.js frontend-overrides/workspace.css
git commit -m "feat(inbox): swipe zone layers + card content wrapper (inert until engine lands)"
```

---

### Task 3: Gesture engine + commit wiring

**Files:**
- Modify: `frontend-overrides/js/inbox.js` (engine block + 3 small integration edits)
- Mirror.

- [ ] **Step 1: Add environment flags + open-card state**

At the state declaration (currently
`let _modal = null, _items = [], ..., _view = 'feed', _toastTimer = null;`),
extend to:

```javascript
  let _modal = null, _items = [], _errors = {}, _counts = {}, _filter = null,
      _view = 'feed', _toastTimer = null, _openCard = null;
  const IS_COARSE = !!(window.matchMedia
    && matchMedia('(pointer: coarse)').matches);
  const REDUCED_MOTION = !!(window.matchMedia
    && matchMedia('(prefers-reduced-motion: reduce)').matches);
```

- [ ] **Step 2: Add the engine block**

Insert directly AFTER the `/* SWIPE-MATH-END */` marker line:

```javascript
  // --- swipe engine (mobile only; spec §1/§3/§4) ----------------------------
  function springShut(el) {
    const content = el && $('.inbox-swipe-content', el);
    if (!content) { if (_openCard === el) _openCard = null; return; }
    content.style.transition = REDUCED_MOTION ? 'none'
      : `transform ${SWIPE.SNAP_MS}ms ${SWIPE.SNAP_EASE}`;
    content.style.transform = 'translate3d(0,0,0)';
    el._swipeX = 0;
    el.querySelectorAll('.swipe-under').forEach((u) => {
      u.classList.remove('swipe-armed');
      u.style.visibility = 'hidden';
    });
    if (_openCard === el) _openCard = null;
  }
  function closeOpenCard() { if (_openCard) springShut(_openCard); }

  async function commitSwipe(it, el, dir) {
    if (el.dataset.pending) return;
    el.dataset.pending = '1';
    const content = $('.inbox-swipe-content', el);
    content.style.transition = REDUCED_MOTION ? 'none'
      : `transform ${SWIPE.SNAP_MS}ms ${SWIPE.SNAP_EASE}`;
    content.style.transform = `translate3d(${dir * el.offsetWidth}px, 0, 0)`;
    try {
      if (dir > 0) {
        const zone = $('.swipe-under-left', el);
        const act = zone.dataset.act;
        if (act === 'reply' || act === 'gary') {
          // spinoff navigates the page on success; spring back meanwhile
          setTimeout(() => springShut(el), SWIPE.SNAP_MS);
          return await handToGary(it, zone, act);
        }
        await doAction(it, act, el, zone);
      } else {
        await doAction(it, 'dismiss', el, $('.swipe-zone-dismiss', el));
      }
      // doAction removes el on success; if it's still attached, it failed —
      // bring the card back so the user sees the ⚠ state.
      if (el.isConnected) springShut(el);
    } finally {
      delete el.dataset.pending;
    }
  }

  function bindSwipe(it, el) {
    const content = $('.inbox-swipe-content', el);
    const leftUnder = $('.swipe-under-left', el);    // shown on RIGHT swipe
    const rightUnder = $('.swipe-under-right', el);  // shown on LEFT swipe
    if (!content || !leftUnder || !rightUnder) return;
    let startX = 0, startY = 0, locked = null, baseX = 0, samples = [],
        armed = false, active = false;

    const maxReveal = (dir) => (dir > 0 ? SWIPE.ZONE_W : SWIPE.ZONE_W * 2);
    const setArmed = (on, dir) => {
      if (on === armed) return;
      armed = on;
      (dir > 0 ? leftUnder : rightUnder).classList.toggle('swipe-armed', on);
    };

    // Tapping a revealed zone fires its action.
    leftUnder.addEventListener('click', () => {
      if (_openCard !== el || el.dataset.pending) return;
      commitSwipe(it, el, 1);
    });
    $('.swipe-zone-snooze', el).addEventListener('click', (e) => {
      e.stopPropagation();
      if (_openCard !== el) return;
      snoozeMenu(it, e.target, el);
    });
    $('.swipe-zone-dismiss', el).addEventListener('click', (e) => {
      e.stopPropagation();
      if (_openCard !== el || el.dataset.pending) return;
      commitSwipe(it, el, -1);
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || el.dataset.pending) return;
      if (_openCard && _openCard !== el) closeOpenCard();
      active = true;
      startX = e.clientX; startY = e.clientY;
      baseX = el._swipeX || 0;
      locked = null;
      samples = [{ x: e.clientX, t: e.timeStamp }];
    });

    el.addEventListener('pointermove', (e) => {
      if (!active || locked === 'v') return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (locked === null) {
        if (Math.abs(dx) < SWIPE.LOCK_PX && Math.abs(dy) < SWIPE.LOCK_PX) return;
        locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        if (locked === 'v') return;            // native scroll owns it now
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
      }
      samples.push({ x: e.clientX, t: e.timeStamp });
      if (samples.length > 5) samples.shift();
      const raw = baseX + dx;
      const dir = raw >= 0 ? 1 : -1;
      const x = swipeRubber(raw, maxReveal(dir));
      content.style.transition = 'none';
      content.style.transform = `translate3d(${x}px, 0, 0)`;
      el._swipeX = x;
      leftUnder.style.visibility = raw > 0 ? 'visible' : 'hidden';
      rightUnder.style.visibility = raw < 0 ? 'visible' : 'hidden';
      setArmed(Math.abs(raw) >= el.offsetWidth * SWIPE.COMMIT_RATIO, dir);
    });

    const finish = () => {
      if (!active) return;
      active = false;
      if (locked !== 'h') { locked = null; return; }
      locked = null;
      el._suppressClick = true;   // the click after a drag is not a tap
      const x = el._swipeX || 0;
      const v = swipeVelocity(samples);
      const out = swipeOutcome(x, v, el.offsetWidth);
      if (out === 'commit') { commitSwipe(it, el, x > 0 ? 1 : -1); return; }
      if (out === 'reveal') {
        const dir = x > 0 ? 1 : -1;
        const content2 = $('.inbox-swipe-content', el);
        content2.style.transition = REDUCED_MOTION ? 'none'
          : `transform ${SWIPE.SNAP_MS}ms ${SWIPE.SNAP_EASE}`;
        content2.style.transform = `translate3d(${dir * maxReveal(dir)}px, 0, 0)`;
        el._swipeX = dir * maxReveal(dir);
        setArmed(false, dir);
        _openCard = el;
        return;
      }
      springShut(el);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', () => {
      active = false; locked = null; springShut(el);
    });

    // Swallow the synthetic click that follows a horizontal drag so buttons
    // under the finger don't fire (tap passthrough stays: no drag, no flag).
    el.addEventListener('click', (e) => {
      if (el._suppressClick) {
        el._suppressClick = false;
        e.stopPropagation(); e.preventDefault();
      }
    }, true);
  }
```

- [ ] **Step 3: Wire it up (3 small edits)**

(a) In `bindCard(it)`, add as the LAST line of the function body:

```javascript
    if (IS_COARSE) bindSwipe(it, el);
```

(b) In `render()`, after the `if (_view === 'history') return renderHistory();`
line, add:

```javascript
    _openCard = null;   // rebuilt DOM: any revealed card is gone with it
```

(c) In `buildModal()`, after the existing
`$('#inbox-history-btn', overlay).addEventListener(...)` line, add:

```javascript
    // Scroll or a touch outside the revealed card closes it (iOS behavior).
    $('#inbox-body', overlay).addEventListener('scroll', closeOpenCard,
                                               { passive: true });
    overlay.addEventListener('pointerdown', (e) => {
      if (_openCard && !_openCard.contains(e.target)) closeOpenCard();
    }, true);
```

- [ ] **Step 4: Verify + mirror**

```bash
cd ~/openclaw-workspace
node scripts/test-swipe-math.mjs && node --check frontend-overrides/js/inbox.js
cp frontend-overrides/js/inbox.js frontend/js/inbox.js
curl -s http://127.0.0.1:8800/static/js/inbox.js | grep -c 'bindSwipe'   # expect 2
```

Desktop regression check (gestures must NOT bind): in headless Chrome the
pointer is fine, so `IS_COARSE` is false — confirm by serving the page and
checking nothing breaks: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8800/` → 200, plus a quick desktop-browser eyeball that buttons/chips/snooze menus still work.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/inbox.js
git commit -m "feat(inbox): swipe gesture engine — direction lock, 1:1 tracking, flick commits, reveal states"
```

---

### Task 4: Phone verification gate + spec status

⚠️ Controller/user task — the feel can only be judged on the actual iPhone.

- [ ] **Step 1: Ask the user to test on their phone** (via the tailnet PWA,
`https://workspace.example.ts.net:8443/`, hard refresh / reopen the
PWA to bust cached JS). Checklist to give them:

```
- vertical feed scrolling still feels native (no jitter, no stuck cards)
- right swipe: zone reveals 1:1 under your finger; past ~60% the label pulses
  (armed); release commits; short release springs back
- flick right from a short distance commits
- left swipe: Snooze | Dismiss reveal; tap Snooze -> presets; full swipe = Dismiss
- ✨ cards show the purple ✨ zone on right-swipe and commit the rec action
- undo toast appears after a swipe-commit; Undo restores the card
- tapping buttons/chips without dragging still works
- only one card stays revealed at a time; scrolling closes it
```

- [ ] **Step 2: Tune if needed.** If the user reports feel issues, adjust ONLY
the `SWIPE` constants (`COMMIT_RATIO`, `FLICK_VMIN`, `SNAP_MS`, `RUBBER`,
`ZONE_W`) in inbox.js, re-run `node scripts/test-swipe-math.mjs` (asserts are
written against `SWIPE.*` references, not literals — they survive tuning),
mirror, and have the user re-test. Each tuning round is one commit:
`git commit -m "tune(inbox): swipe feel — <what changed>"`.

- [ ] **Step 3: Spec status + commit** (after the user signs off):

Append to `docs/superpowers/specs/2026-06-07-inbox-swipe-gestures-design.md`:

```markdown
## Status

Implemented 2026-06-07 (plan
`docs/superpowers/plans/2026-06-07-inbox-swipe-gestures.md`); pure gesture
math node-asserted; verified by the user on iPhone via the tailnet PWA.
```

```bash
git add docs/superpowers/specs/2026-06-07-inbox-swipe-gestures-design.md
git commit -m "feat(inbox): swipe triage verified on device"
```

---

## Self-review notes (run after drafting — issues found and fixed inline)

- **Spec coverage:** §1 engine (T3: lock/capture/rubber/velocity/springs/
  pointercancel/tap-passthrough+click-suppression) ✓; §2 zones (T2 markup+CSS,
  T3 visibility/armed toggling, one-card-at-a-time + scroll-close in T3 step 3c)
  ✓; §3 outcomes (T1 swipeOutcome, T3 finish/commitSwipe incl. reply/gary
  spring-back and isConnected error recovery) ✓; §4 robustness (history drawer
  untouched — bindSwipe only runs via bindCard which only renders feed cards;
  reduced-motion in JS + CSS; pending guard) ✓; §5 testing (T1 node asserts,
  T4 device gate with tunable constants) ✓.
- **Type consistency:** `swipeRubber/swipeVelocity/swipeOutcome` names match
  between the math block, the engine, and the assert script's extraction;
  `el._swipeX`/`el._suppressClick` used consistently; `maxReveal(dir)` defined
  in bindSwipe and duplicated nowhere else.
- **Judgment calls:** zone-arming reads `el.offsetWidth` per move (cheap,
  layout already clean); `IS_COARSE` evaluated once at load (device class
  doesn't change mid-session); the right-swipe zone for `reply`/`gary` fires
  spinoff rather than a card removal — card springs back by design since the
  page navigates away on success.
