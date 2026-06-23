# Activity Trail — Cowork Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the redesign's activity trail Cowork-grade — a finished turn rests as a one-line summary that expands to compact rows, consecutive same-tool runs collapse into a single group, and the same renderer drives live streaming (running step streams standalone) with auto-collapse on finish.

**Architecture:** A new pure module `chat-activity-group.js` groups consecutive same-kind completed steps and summarizes a turn. `renderActivity` (in `chat-activity.js`) is reworked to render a three-level disclosure (summary → grouped rows → leaf detail) using that module, sharing one code path between the live "working" state and the resting "done" state. A third collapse level (`group`) is added to `s.chatUI`.

**Tech Stack:** Vanilla ES modules (no framework); Node's built-in `node:test`/`node:assert` for unit tests; `scripts/sync-frontend.sh` to build; Playwright + chromium for integration verification.

## Global Constraints

- Source lives in `frontend-overrides/`; `frontend/` is generated — **never edit `frontend/` directly**. After source edits, rebuild with `scripts/sync-frontend.sh`.
- Frontend unit tests run with Node's built-in runner from `frontend-overrides/js/`: `node --test __tests__/<file>.test.js`. The dir has `package.json` `{"type":"module"}`, so use ESM `import`.
- This is redesign-only (`frontend-overrides/js/redesign/`). Do not touch the classic SPA.
- The renderer must stay pure-string (node-importable): no `document`/`window` at module top level or inside `renderActivity`.
- Reuse existing helpers: `stepRow`, `activeStep`, `stepDetail`, `codeBlock`, `ACT_ICONS`, `chev`, `checkIcon` (in `chat-activity.js`); `esc`, `map`, `when` (`dom.js`); `icon` (`icons.js`).

---

### Task 1: Pure grouping + summary module

**Files:**
- Create: `frontend-overrides/js/redesign/chat-activity-group.js`
- Test: `frontend-overrides/js/__tests__/chat-activity-group.test.js`

**Interfaces:**
- Produces:
  - `groupSteps(steps) → Array<{type:'single', step} | {type:'group', kind:string, id:string, steps:Step[]}>` — groups maximal runs of ≥2 consecutive completed steps with the same `kind`; `think` steps and `state==='running'` steps are always emitted as `single` and break a run. Group `id` is `` `g-${firstStep.id}` ``.
  - `groupLabel(kind, count) → string` — e.g. `"Ran 11 commands"`, `"Read 2 files"`, `"Searched 3 times"`.
  - `summarize(steps) → { parts: string[], failed: number }` — per-kind counts in first-seen order phrased as `parts` (e.g. `["3 files read","1 search","11 commands"]`); `failed` counts steps with `state==='error'`; `think` steps are excluded.
- `Step` shape (existing): `{ id, kind, label, file?, meta?, metaColor?, state:'running'|'done'|'error', body?, lines? }`.

- [ ] **Step 1: Write the failing tests**

Create `frontend-overrides/js/__tests__/chat-activity-group.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { groupSteps, groupLabel, summarize } from '../redesign/chat-activity-group.js';

const step = (id, kind, state = 'done') => ({ id, kind, state, label: kind, lines: [] });

test('consecutive same-kind runs (>=2) group; a lone run stays single', () => {
  const items = groupSteps([
    step('a', 'read'),
    step('b', 'run'), step('c', 'run'), step('d', 'run'),
    step('e', 'read'),
  ]);
  assert.deepEqual(items.map((i) => i.type), ['single', 'group', 'single']);
  assert.equal(items[1].kind, 'run');
  assert.equal(items[1].steps.length, 3);
  assert.equal(items[1].id, 'g-b'); // id from first member
});

test('a running step never groups and breaks the current run', () => {
  const items = groupSteps([
    step('a', 'run'), step('b', 'run'),
    step('c', 'run', 'running'),
  ]);
  assert.deepEqual(items.map((i) => i.type), ['group', 'single']);
  assert.equal(items[1].step.id, 'c');
});

test('thinking steps never group', () => {
  const items = groupSteps([step('a', 'think'), step('b', 'think')]);
  assert.deepEqual(items.map((i) => i.type), ['single', 'single']);
});

test('all one kind collapses to a single group', () => {
  const items = groupSteps(Array.from({ length: 48 }, (_, i) => step('s' + i, 'run')));
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'group');
  assert.equal(items[0].steps.length, 48);
});

test('groupLabel is plural and kind-specific', () => {
  assert.equal(groupLabel('run', 11), 'Ran 11 commands');
  assert.equal(groupLabel('read', 2), 'Read 2 files');
  assert.equal(groupLabel('grep', 3), 'Searched 3 times');
});

test('summarize counts per kind in first-seen order, excludes thinking, tallies failures', () => {
  const out = summarize([
    step('t', 'think'),
    step('a', 'read'), step('b', 'read'), step('c', 'read'),
    step('d', 'grep'),
    step('e', 'run'), step('f', 'run', 'error'),
  ]);
  assert.deepEqual(out.parts, ['3 files read', '1 search', '2 commands']);
  assert.equal(out.failed, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend-overrides/js && node --test __tests__/chat-activity-group.test.js`
Expected: FAIL — `Cannot find module '../redesign/chat-activity-group.js'`.

- [ ] **Step 3: Write the module**

Create `frontend-overrides/js/redesign/chat-activity-group.js`:

```js
// Pure helpers for the activity trail. No DOM / browser deps — unit-tested under
// node:test. (1) groupSteps collapses consecutive same-kind COMPLETED steps into
// groups for the expanded view; (2) summarize aggregates a turn for the collapsed
// summary line. Thinking steps and the currently-running step never group.

const GROUP_LABEL = {
  read: (n) => `Read ${n} files`,
  edit: (n) => `Edited ${n} files`,
  grep: (n) => `Searched ${n} times`,
  run: (n) => `Ran ${n} commands`,
  web: (n) => `Searched the web ${n} times`,
  generic: (n) => `Ran ${n} tools`,
};

const PHRASE = {
  read: (n) => `${n} ${n === 1 ? 'file' : 'files'} read`,
  edit: (n) => `${n} ${n === 1 ? 'file' : 'files'} edited`,
  grep: (n) => `${n} ${n === 1 ? 'search' : 'searches'}`,
  run: (n) => `${n} ${n === 1 ? 'command' : 'commands'}`,
  web: (n) => `${n} web ${n === 1 ? 'search' : 'searches'}`,
  generic: (n) => `${n} ${n === 1 ? 'tool' : 'tools'}`,
};

/** Ordered render items: {type:'single',step} | {type:'group',kind,id,steps}. */
export function groupSteps(steps) {
  const items = [];
  let run = null; // { kind, steps:[] }
  const flush = () => {
    if (!run) return;
    if (run.steps.length >= 2) {
      items.push({ type: 'group', kind: run.kind, id: `g-${run.steps[0].id}`, steps: run.steps });
    } else {
      items.push({ type: 'single', step: run.steps[0] });
    }
    run = null;
  };
  for (const st of steps || []) {
    if (st.kind === 'think' || st.state === 'running') {
      flush();
      items.push({ type: 'single', step: st });
      continue;
    }
    if (run && run.kind === st.kind) run.steps.push(st);
    else { flush(); run = { kind: st.kind, steps: [st] }; }
  }
  flush();
  return items;
}

/** Plural, kind-specific group line, e.g. "Ran 11 commands". */
export function groupLabel(kind, count) {
  return (GROUP_LABEL[kind] || GROUP_LABEL.generic)(count);
}

/** { parts:[string], failed:number } for the collapsed summary line. */
export function summarize(steps) {
  const order = [];
  const counts = new Map();
  let failed = 0;
  for (const st of steps || []) {
    if (st.kind === 'think') continue;
    if (!counts.has(st.kind)) order.push(st.kind);
    counts.set(st.kind, (counts.get(st.kind) || 0) + 1);
    if (st.state === 'error') failed += 1;
  }
  const parts = order.map((kind) => (PHRASE[kind] || PHRASE.generic)(counts.get(kind)));
  return { parts, failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend-overrides/js && node --test __tests__/chat-activity-group.test.js`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/redesign/chat-activity-group.js frontend-overrides/js/__tests__/chat-activity-group.test.js
git commit -m "Activity trail: pure groupSteps/summarize/groupLabel module + tests"
```

---

### Task 2: Rework renderActivity (done state) + collapse wiring

**Files:**
- Modify: `frontend-overrides/js/redesign/chat-activity.js` (imports; add `summaryText`, `renderItem`; rewrite `renderActivity`)
- Modify: `frontend-overrides/js/redesign/app.js` (`chatUI` init line ~22; `toggleTrail`/`toggleStep` area line ~143-144)
- Test: `frontend-overrides/js/__tests__/chat-activity-render.test.js`

**Interfaces:**
- Consumes: `groupSteps`, `groupLabel`, `summarize` (Task 1).
- Produces:
  - `renderActivity(m, s)` — done turns render a collapsible summary, **collapsed by default** (open only when `s.chatUI.trail[m.id] === true`); expanded shows `renderItem`-rendered groups/rows.
  - `renderItem(item, s, working) → string` — renders one `groupSteps` item; `group` → a `data-act="toggleGroup"` line + (when open) a `.act-subspine` of member `stepRow`s; `single` running → `activeStep`; `single` done → `stepRow` (with green check when `working`).
  - app.js: `state.chatUI.group` object; `actions.toggleGroup(id)`; `actions.toggleTrail` now defaults closed (`t[id] = !t[id]`).

- [ ] **Step 1: Write the failing render tests**

Create `frontend-overrides/js/__tests__/chat-activity-render.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { renderActivity } from '../redesign/chat-activity.js';

const step = (id, kind, state = 'done', extra = {}) =>
  ({ id, kind, state, label: kind, file: kind + '-target', lines: [], ...extra });
const ui = (over = {}) => ({ chatUI: { trail: {}, step: {}, group: {}, ...over } });

const doneMsg = (steps) => ({ id: 'm1', role: 'assistant', activity: { status: 'done', elapsed: '31s', steps } });

test('done turn is collapsed by default: summary only, no expanded spine', () => {
  const html = renderActivity(doneMsg([step('a', 'run'), step('b', 'run')]), ui());
  assert.match(html, /act-summary/);
  assert.match(html, /Worked for 31s/);
  assert.match(html, /2 commands/);
  assert.doesNotMatch(html, /act-spine/); // not expanded
});

test('expanded done turn shows a group line with toggleGroup and a count label', () => {
  const html = renderActivity(
    doneMsg([step('a', 'run'), step('b', 'run'), step('c', 'run')]),
    ui({ trail: { m1: true } }),
  );
  assert.match(html, /act-spine/);
  assert.match(html, /data-act="toggleGroup"/);
  assert.match(html, /data-arg="g-a"/);
  assert.match(html, /Ran 3 commands/);
});

test('expanding a group reveals its member rows', () => {
  const html = renderActivity(
    doneMsg([step('a', 'run'), step('b', 'run')]),
    ui({ trail: { m1: true }, group: { 'g-a': true } }),
  );
  assert.match(html, /act-subspine/);
  assert.match(html, /data-act="toggleStep" data-arg="a"/);
  assert.match(html, /data-act="toggleStep" data-arg="b"/);
});

test('a lone run renders as a normal row, not a group', () => {
  const html = renderActivity(doneMsg([step('a', 'run')]), ui({ trail: { m1: true } }));
  assert.doesNotMatch(html, /toggleGroup/);
  assert.match(html, /data-act="toggleStep" data-arg="a"/);
});

test('failures bubble to the summary and the group line', () => {
  const steps = [step('a', 'run'), step('b', 'run', 'error')];
  const collapsed = renderActivity(doneMsg(steps), ui());
  assert.match(collapsed, /1 failed/);
  const expanded = renderActivity(doneMsg(steps), ui({ trail: { m1: true } }));
  assert.match(expanded, /1 failed/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend-overrides/js && node --test __tests__/chat-activity-render.test.js`
Expected: FAIL — current `renderActivity` defaults expanded (no `toggleGroup`, no `act-subspine`, summary text differs).

- [ ] **Step 3: Add imports + helpers to `chat-activity.js`**

At the top of `frontend-overrides/js/redesign/chat-activity.js`, after the existing `import` lines, add:

```js
import { groupSteps, groupLabel, summarize } from './chat-activity-group.js';
```

Then add these two helpers above the existing `renderActivity` (keep `renderWorking` for now — Task 3 reworks it):

```js
function summaryText(act) {
  const { parts, failed } = summarize(act.steps);
  const segs = [];
  if (act.elapsed) segs.push(`Worked for ${act.elapsed}`);
  if (parts.length) segs.push(parts.join(', '));
  if (!segs.length) segs.push('Worked');
  let txt = segs.join(' · ');
  if (failed) txt += ` · ${failed} failed`;
  return { txt, failed };
}

// Render one groupSteps item. `working` shows completed singles with a green check.
function renderItem(it, s, working) {
  if (it.type === 'group') {
    const open = !!((s.chatUI && s.chatUI.group) || {})[it.id];
    const failed = it.steps.filter((x) => x.state === 'error').length;
    const ic = ACT_ICONS[it.kind] || ACT_ICONS.generic;
    const meta = failed
      ? `<span class="meta" style="color:var(--red)">${failed} failed</span>` : '';
    const head = `<div class="act-group ocact" data-act="toggleGroup" data-arg="${esc(it.id)}">`
      + `<span class="act-ic" style="color:${ic.color}">${icon(ic.path, { size: 13, sw: 1.8 })}</span>`
      + `<span class="lbl">${esc(groupLabel(it.kind, it.steps.length))}</span>`
      + `<div class="oc-spacer"></div>${meta}${chev(open ? '90deg' : '0deg')}</div>`;
    const body = open
      ? `<div class="act-spine act-subspine">${map(it.steps, (st) => stepRow(st, s))}</div>` : '';
    return head + body;
  }
  const st = it.step;
  if (st.state === 'running') return activeStep(st);
  return working ? stepRow(st, s, { iconHtml: checkIcon(13) }) : stepRow(st, s);
}
```

- [ ] **Step 4: Rewrite `renderActivity` in `chat-activity.js`**

Replace the existing `renderActivity` function body with:

```js
/** Render the activity trail for a message (returns '' when there's none). */
export function renderActivity(m, s) {
  const act = m.activity;
  if (!act || !act.steps || !act.steps.length) return '';
  if (act.status === 'working') return renderWorking(m, act); // Task 3 reworks this

  const trailOpen = !!((s.chatUI && s.chatUI.trail) || {})[m.id]; // default COLLAPSED
  const { txt, failed } = summaryText(act);
  const items = groupSteps(act.steps);
  return `
  <div class="act-wrap">
    <div class="act-summary ocact" data-act="toggleTrail" data-arg="${esc(m.id)}">
      <span style="display:flex;color:${failed ? 'var(--red)' : 'var(--green)'}">${checkIcon(13)}</span>
      <span class="act-worked">${esc(txt)}</span>
      ${chev(trailOpen ? '90deg' : '0deg')}
    </div>
    ${when(trailOpen, `<div class="act-spine">${items.map((it) => renderItem(it, s, false)).join('')}</div>`)}
  </div>`;
}
```

Note: this keeps the existing `renderWorking(m, act)` call untouched, so the live "working" trail is unchanged by this task (Task 3 reworks it). This task's deliverable is the **done** state only.

- [ ] **Step 5: Wire collapse state in `app.js`**

In `frontend-overrides/js/redesign/app.js`:

Change the `chatUI` initializer (line ~22) from:
```js
  chatUI: { trail: {}, step: {} }, // activity-trail collapse state (per msg/step)
```
to:
```js
  chatUI: { trail: {}, step: {}, group: {} }, // activity-trail collapse (msg/step/group)
```

Change `toggleTrail` (line ~143) from:
```js
  toggleTrail: (id) => { const t = state.chatUI.trail; t[id] = t[id] === false ? true : false; },
```
to (default collapsed now, so simple boolean toggle) and add `toggleGroup` right after `toggleStep`:
```js
  toggleTrail: (id) => { const t = state.chatUI.trail; t[id] = !t[id]; },
  toggleStep: (id) => { const st = state.chatUI.step; st[id] = !st[id]; },
  toggleGroup: (id) => { const g = state.chatUI.group; g[id] = !g[id]; },
```

(The generic `data-act` delegation in `app.js` already routes `toggleGroup` to `actions.toggleGroup` — no delegation change needed.)

- [ ] **Step 6: Run render tests to verify they pass**

Run: `cd frontend-overrides/js && node --test __tests__/chat-activity-render.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 7: Run the full frontend test suite (no regressions)**

Run: `cd frontend-overrides/js && node --test '__tests__/*.test.js'`
Expected: PASS — all tests pass (existing terminal tests + group + render).

- [ ] **Step 8: Commit**

```bash
git add frontend-overrides/js/redesign/chat-activity.js frontend-overrides/js/redesign/app.js frontend-overrides/js/__tests__/chat-activity-render.test.js
git commit -m "Activity trail: collapsible summary + grouped rows on done turns"
```

---

### Task 3: Rework the live "working" state to share grouping

**Files:**
- Modify: `frontend-overrides/js/redesign/chat-activity.js` (`renderWorking`)
- Test: `frontend-overrides/js/__tests__/chat-activity-render.test.js` (add cases)

**Interfaces:**
- Consumes: `groupSteps` (Task 1), `renderItem` (Task 2).
- Produces: `renderWorking(m, s)` — the `Working… {elapsed} · Stop` header followed by `renderItem(it, s, true)` for each grouped item, so completed consecutive runs group live and the running step renders standalone via `activeStep`.

- [ ] **Step 1: Write the failing tests (append to the render test file)**

Append to `frontend-overrides/js/__tests__/chat-activity-render.test.js`:

```js
const workingMsg = (steps, elapsed = '14s') =>
  ({ id: 'm2', role: 'assistant', activity: { status: 'working', elapsed, steps } });

test('working state groups completed runs and streams the running step standalone', () => {
  const html = renderActivity(workingMsg([
    step('a', 'run'), step('b', 'run'),     // done -> group
    step('c', 'run', 'running'),            // running -> standalone activeStep
  ]), ui());
  assert.match(html, /Working/);            // working header
  assert.match(html, /Stop/);               // stop button
  assert.match(html, /Ran 2 commands/);     // completed run grouped
  assert.match(html, /act-working/);        // running step rendered as active
});

test('working state shows a single completed step with a check, not a group', () => {
  const html = renderActivity(workingMsg([
    step('a', 'read'),
    step('b', 'run', 'running'),
  ]), ui());
  assert.doesNotMatch(html, /toggleGroup/);  // lone read not grouped
  assert.match(html, /data-act="toggleStep" data-arg="a"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend-overrides/js && node --test __tests__/chat-activity-render.test.js`
Expected: FAIL — current `renderWorking` doesn't group (no `Ran 2 commands`).

- [ ] **Step 3: Rewrite `renderWorking` in `chat-activity.js`**

Replace the existing `renderWorking` function with:

```js
function renderWorking(m, s) {
  const act = m.activity;
  const rows = groupSteps(act.steps).map((it) => renderItem(it, s, true)).join('');
  return `
  <div class="act-wrap"><div class="act-spine">
    <div class="act-working">
      <span class="act-spinner"></span>
      <span class="shimmer act-shim">Working…</span>
      ${act.elapsed ? `<span class="act-elapsed">${esc(act.elapsed)}</span>` : ''}
      <div class="oc-spacer"></div>
      <button class="act-stop ocbtn" data-act="stopRun" data-arg="${esc(m.id)}">${STOP_ICON}Stop</button>
    </div>
    ${rows}
  </div></div>`;
}
```

Also update the call site: in `renderActivity` change `return renderWorking(m, act);` to `return renderWorking(m, s);` (the new `renderWorking` needs `s` for group collapse state). The old `renderWorking(m, act)` body that mapped steps directly is fully replaced.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend-overrides/js && node --test __tests__/chat-activity-render.test.js`
Expected: PASS — all render tests (Task 2 + Task 3) pass.

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend-overrides/js && node --test '__tests__/*.test.js'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend-overrides/js/redesign/chat-activity.js frontend-overrides/js/__tests__/chat-activity-render.test.js
git commit -m "Activity trail: live working state shares grouping; running step standalone"
```

---

### Task 4: CSS + rebuild + integration verification

**Files:**
- Modify: `frontend-overrides/css/activity-tree.css` (add `.act-group`, `.act-subspine`)
- Verify: `frontend/` build via `scripts/sync-frontend.sh`; headless browser against the running app on `:8800`.

**Interfaces:**
- Consumes: the classes emitted by `renderItem` (`.act-group`, `.act-subspine`).

- [ ] **Step 1: Add group styles to `activity-tree.css`**

Append to `frontend-overrides/css/activity-tree.css`:

```css
/* Grouped run line (e.g. "Ran 11 commands") — same rhythm as .act-row, clickable. */
.act-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 13.5px;
  cursor: pointer;
}
.act-group .lbl { color: var(--fg, #e7eaf0); }
.act-group:hover .lbl { color: #fff; }
/* Member rows of an expanded group sit on a lighter, inset spine. */
.act-subspine {
  border-left-color: #23262e;
  margin-left: 8px;
}
```

- [ ] **Step 2: Rebuild the frontend**

Run: `scripts/sync-frontend.sh`
Expected: ends with "stamped sw.js CACHE_NAME = gary-<hash>" and no errors.

- [ ] **Step 3: Confirm the built output carries the changes**

Run:
```bash
grep -c "act-group\|act-subspine" frontend/css/activity-tree.css
grep -c "toggleGroup\|chat-activity-group" frontend/js/redesign/chat-activity.js
```
Expected: first ≥ 2; second ≥ 1.

- [ ] **Step 4: Integration verify on reload (headless)**

Ensure the app is running on `:8800` (restart if needed:
`nohup .venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8800 --log-level warning >/dev/null 2>&1 &`).

Create `/tmp/verify-trail.mjs`:
```js
import pkg from '/home/frank/code/openclaw/node_modules/playwright/index.js';
const { chromium } = pkg;
const URL = 'http://127.0.0.1:8800/static/index-redesign.html';
const b = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await b.newPage();
const errs = []; page.on('pageerror', (e) => errs.push('' + e));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
// open the 48-bash session
await page.evaluate(() => {
  const r = [...document.querySelectorAll('.conv-row')].find((x) => /activity dra/i.test(x.innerText));
  if (r) r.click();
});
await page.waitForTimeout(2500);
const collapsed = await page.evaluate(() => ({
  summaries: document.querySelectorAll('.act-summary').length,
  spinesOpen: document.querySelectorAll('.act-spine').length, // 0 == collapsed by default
}));
// expand the first trail
await page.evaluate(() => document.querySelector('.act-summary')?.click());
await page.waitForTimeout(400);
const expanded = await page.evaluate(() => ({
  groups: document.querySelectorAll('.act-group').length,
  groupLabel: document.querySelector('.act-group .lbl')?.innerText || '',
}));
// expand the first group
await page.evaluate(() => document.querySelector('.act-group')?.click());
await page.waitForTimeout(400);
const drilled = await page.evaluate(() => document.querySelectorAll('.act-subspine .act-row').length);
console.log('collapsed:', JSON.stringify(collapsed));
console.log('expanded:', JSON.stringify(expanded));
console.log('group member rows:', drilled);
console.log('pageerrors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
```
Run: `node /tmp/verify-trail.mjs`
Expected: `collapsed.spinesOpen` is `0` (trails collapsed by default); after expanding, `expanded.groups ≥ 1` with a label like `Ran 48 commands`; `group member rows` > 0; `pageerrors: none`.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/css/activity-tree.css
git commit -m "Activity trail: group-line + sub-spine styling; Cowork-parity trail complete"
```

---

## Self-Review notes (already reconciled)

- **Spec coverage:** three-level disclosure (Tasks 2–3), consecutive grouping (Task 1), live streaming + auto-collapse (Task 3 + done-default-collapsed in Task 2), summary/format/errors (Tasks 1–2), CSS polish (Task 4). Reload caveats (no timing/thinking) need no task — they're inherent. Thinking-on-reload is a documented fast-follow in the spec, intentionally out of this plan.
- **Type consistency:** `groupSteps` item shape (`{type,kind,id,steps}` / `{type,step}`), `summarize` return (`{parts,failed}`), and `s.chatUI.{trail,step,group}` are used identically across Tasks 1–3. Group `id` = `g-${firstStep.id}` is produced in Task 1 and asserted in Task 2 (`g-a`).
- **No placeholders:** every code/step block is complete and runnable.
