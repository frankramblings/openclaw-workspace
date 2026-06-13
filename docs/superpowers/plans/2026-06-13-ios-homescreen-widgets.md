# Gary iOS Home/Lock-Screen Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user launch Gary (the openclaw-workspace PWA) into a specific mode — new chat, photo, voice, inbox — from iPhone Home/Lock-Screen launch buttons, ChatGPT-widget style.

**Architecture:** The only code is a small frontend module, `frontend-overrides/js/deeplink.js`, that reads a `?action=` query param once at boot and drives the **existing** composer/inbox controls (`#rail-new-session`, `#message`, `#overflow-attach-btn`, `#rail-inbox`), then strips the param. The on-device pieces — Apple **Shortcuts** (Phase 1) and a **Scriptable** widget (Phase 2) — are just buttons that open `…/?action=<x>` URLs. No backend changes, no new endpoints.

**Tech Stack:** Vanilla ES-module JS (browser), `sync-frontend.sh` build (auto-precache + `CACHE_NAME` bump), node v22 for the unit test, Apple Shortcuts, Scriptable (JS).

**Spec:** `docs/superpowers/specs/2026-06-13-ios-homescreen-widgets-design.md`

---

## File Structure

**Code (committed, durable source under `frontend-overrides/`):**
- Create `frontend-overrides/js/deeplink.js` — the deep-link reader. One responsibility: map `?action=` → a plan, dispatch to existing DOM controls, strip the param. Pure mapping (`planForAction`) is unit-tested; `applyPlan` is the thin DOM shell.
- Create `frontend-overrides/js/package.json` — `{"type":"module"}`, so node treats the `js/*.js` ES modules as ESM for the unit test (browsers ignore it; harmless in the deployed bundle).
- Modify `frontend-overrides/app.js` — add one `import './js/deeplink.js';` so the module loads and self-inits.

**Test (committed, NOT shipped to the bundle — lives outside `frontend-overrides/`):**
- Create `scripts/test/deeplink.test.mjs` — node-assert test of the pure `planForAction` mapping.

**Widget deliverable (committed, pasted onto the phone by the user):**
- Create `deploy/ios/gary-widget.scriptable.js` — the Scriptable widget script.
- Create `deploy/ios/README.md` — the on-device Shortcuts + Scriptable setup steps.

**Generated (gitignored, produced by `sync-frontend.sh`, never committed):** `frontend/**`, including the stamped `frontend/sw.js`.

---

## Task 1: Deep-link reader module (`deeplink.js`)

**Files:**
- Create: `frontend-overrides/js/deeplink.js`
- Create: `frontend-overrides/js/package.json`
- Test: `scripts/test/deeplink.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/deeplink.test.mjs`:

```js
import assert from 'node:assert/strict';
import { planForAction } from '../../frontend-overrides/js/deeplink.js';

assert.equal(planForAction('new').newChat, true);
assert.equal(planForAction('new').focus, 'input');
assert.equal(planForAction('photo').newChat, true);
assert.equal(planForAction('photo').openAttach, true);
assert.equal(planForAction('photo').focus, 'none');
assert.equal(planForAction('voice').newChat, true);
assert.equal(planForAction('voice').openAttach, false);
assert.equal(planForAction('inbox').openInbox, true);
assert.equal(planForAction('inbox').newChat, false);
assert.equal(planForAction('NEW').newChat, true);     // case-insensitive
assert.equal(planForAction('bogus'), null);
assert.equal(planForAction(undefined), null);
assert.equal(planForAction(''), null);

console.log('deeplink planForAction: 13 assertions OK');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test/deeplink.test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (deeplink.js does not exist yet).

- [ ] **Step 3: Create the ESM marker so the test can import the module**

Create `frontend-overrides/js/package.json`:

```json
{ "type": "module" }
```

- [ ] **Step 4: Write the module**

Create `frontend-overrides/js/deeplink.js`:

```js
// Widget/Shortcut deep links: ?action=new|photo|voice|inbox is dispatched once
// at boot to the existing composer/inbox controls, then stripped from the URL.
// Pure mapping (planForAction) is unit-tested; applyPlan is the thin DOM shell.
// Spec: docs/superpowers/specs/2026-06-13-ios-homescreen-widgets-design.md

export const ACTION_PLANS = {
  new:   { newChat: true,  focus: 'input', openAttach: false, openInbox: false },
  photo: { newChat: true,  focus: 'none',  openAttach: true,  openInbox: false },
  voice: { newChat: true,  focus: 'none',  openAttach: false, openInbox: false },
  inbox: { newChat: false, focus: 'none',  openAttach: false, openInbox: true  },
};

// Pure: map an action string to its plan, or null if unrecognized.
export function planForAction(action) {
  if (typeof action !== 'string') return null;
  return ACTION_PLANS[action.toLowerCase()] || null;
}

// Poll for a selector (e.g. #rail-inbox is injected late by inbox.js).
// Resolves the element, or null after `tries` attempts.
function _waitFor(selector, tries = 40, interval = 50) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      if (++n >= tries) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

// Thin DOM shell: drive existing controls per the plan. Best-effort; never throws.
export async function applyPlan(plan) {
  if (!plan) return;
  try {
    if (plan.openInbox) {
      const inbox = (await _waitFor('#rail-inbox'))
        || document.getElementById('inbox-section-title');
      if (inbox) inbox.click();
      return;
    }
    if (plan.newChat) {
      const railNew = await _waitFor('#rail-new-session');
      if (railNew) railNew.click();
      // Let the new chat render before touching composer controls.
      await new Promise((r) => setTimeout(r, 150));
    }
    if (plan.focus === 'input') {
      const input = document.getElementById('message');
      if (input) input.focus();
    }
    if (plan.openAttach) {
      // Best-effort: open the attach picker. iOS Safari blocks file-input
      // activation without a user gesture on a fresh load, so this may no-op —
      // by design the user then lands in a new chat with attach one tap away.
      const attach = document.getElementById('overflow-attach-btn');
      if (attach) { try { attach.click(); } catch (_) {} }
    }
  } catch (_) { /* deep-link is best-effort; never block boot */ }
}

// Read ?action=, strip it immediately (clean reload/back), then dispatch.
export function initDeepLinks() {
  let params;
  try { params = new URLSearchParams(window.location.search); } catch (_) { return; }
  const action = params.get('action');
  if (!action) return;
  const plan = planForAction(action);
  // Strip the param regardless, so a refresh doesn't replay the action.
  try {
    params.delete('action');
    const qs = params.toString();
    const clean = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    window.history.replaceState(null, '', clean);
  } catch (_) { /* ignore */ }
  if (!plan) return;
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    applyPlan(plan);
  } else {
    window.addEventListener('DOMContentLoaded', () => applyPlan(plan), { once: true });
  }
}

// Auto-init only in a real browser (skipped under node unit tests).
if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.location) {
  initDeepLinks();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/test/deeplink.test.mjs`
Expected: PASS — prints `deeplink planForAction: 13 assertions OK`.

- [ ] **Step 6: Syntax-check the module (browser-parse gate; no headless Chrome)**

Run: `node --check frontend-overrides/js/deeplink.js`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add frontend-overrides/js/deeplink.js frontend-overrides/js/package.json scripts/test/deeplink.test.mjs
git commit -m "feat(deeplink): ?action= reader maps widget launches to composer/inbox controls"
```

---

## Task 2: Wire the module into the app

**Files:**
- Modify: `frontend-overrides/app.js` (import block, around line 20)

- [ ] **Step 1: Add the import**

In `frontend-overrides/app.js`, find the existing voiceRecorder import (line ~20):

```js
import voiceRecorderModule from './js/voiceRecorder.js';
```

Add immediately after it:

```js
import './js/deeplink.js';  // ?action= widget/Shortcut deep links (self-inits)
```

- [ ] **Step 2: Syntax-check app.js**

Run: `node --check frontend-overrides/app.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add frontend-overrides/app.js
git commit -m "feat(deeplink): load deep-link reader at app boot"
```

---

## Task 3: Build and verify the served frontend

**Files:**
- Run: `scripts/sync-frontend.sh` (writes gitignored `frontend/`)

- [ ] **Step 1: Build**

Run: `bash scripts/sync-frontend.sh`
Expected: prints `applied overrides …`, `injected N precache entries into sw.js`, and `stamped sw.js CACHE_NAME = gary-<hash>`.

- [ ] **Step 2: Confirm the new module deployed and is precached**

Run: `grep -c "js/deeplink.js" frontend/sw.js`
Expected: `1` (the module is in the auto-generated precache manifest).

Run: `test -f frontend/js/deeplink.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Confirm CACHE_NAME changed**

Run: `grep "const CACHE_NAME" frontend/sw.js`
Expected: a `gary-<10hex>` value (changed from the previous build).

- [ ] **Step 4: Verify the deep-link routes serve the SPA shell**

The backend serves the SPA for any path/query, so the workspace must be running on `127.0.0.1:8800` (it normally is). Run:

```bash
for a in new photo voice inbox; do
  printf '%s -> ' "$a"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8800/?action=$a"
done
```

Expected: each line ends in `200`.

- [ ] **Step 5: No commit needed**

`frontend/` is gitignored generated output. The only committed artifacts are from Tasks 1–2. Confirm:

Run: `git status --porcelain frontend/ | head`
Expected: empty (nothing under `frontend/` is tracked).

---

## Task 4: Deploy (USER-GATED — do not run unprompted)

> The host is a 2014 Mac mini (8 GB, swaps hard); a gateway/workspace cold-boot can take minutes. Restart **once**, only when the user says go. See memory `project_hardware_constraint`.

- [ ] **Step 1: Restart the workspace LaunchAgent** (user runs, or confirms)

Run (the workspace uvicorn service): `launchctl kickstart -k gui/$(id -u)/ai.openclaw.workspace`
(Verify the label first with `launchctl list | grep workspace` — expect `ai.openclaw.workspace`.)

- [ ] **Step 2: Server-verify the live build**

```bash
curl -s http://127.0.0.1:8800/static/sw.js | grep "const CACHE_NAME"   # matches Task 3 stamp
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8800/?action=new   # 200
```

- [ ] **Step 3: User browser smoke (can't machine-verify)**

On the `:8443` tailnet origin, after one online load (so the new SW installs): open `…:8443/?action=new` → lands in a new chat, composer focused; `?action=inbox` → Inbox opens; `?action=photo` → new chat, attach reachable; `?action=voice` → new chat, mic affordance present.

---

## Task 5: Phase 1 — Apple Shortcuts (on-device, $0, no app install)

**Files:**
- Reference: `deploy/ios/README.md` (Step 1 creates it)

- [ ] **Step 1: Write the on-device setup doc**

Create `deploy/ios/README.md`:

```markdown
# Gary iOS launch widgets

Base URL (Tailscale must be connected on the iPhone):
`https://bespin.bicolor-triceratops.ts.net:8443`

## Phase 1 — Shortcuts (built-in, no install)

Make four shortcuts. For each: Shortcuts app → **+** → **Add Action** →
**Web ▸ Open URLs** → paste the URL → name it → Done.

| Shortcut name | URL |
|---|---|
| Ask Gary      | `https://bespin.bicolor-triceratops.ts.net:8443/?action=new`   |
| Photo to Gary | `https://bespin.bicolor-triceratops.ts.net:8443/?action=photo` |
| Voice to Gary | `https://bespin.bicolor-triceratops.ts.net:8443/?action=voice` |
| Gary Inbox    | `https://bespin.bicolor-triceratops.ts.net:8443/?action=inbox` |

**Home Screen:** long-press home screen → **+** → **Shortcuts** → add the
"Shortcut" widget → pick *Ask Gary* (or the medium widget to show several).

**Lock Screen:** long-press Lock Screen → **Customize** → **Lock Screen** →
tap the widget row → **Shortcuts** → add *Ask Gary* (and *Photo to Gary*).

Note: tapping opens the URL in **Safari**, not the standalone home-screen PWA
(iOS limitation — no widget can force-open an installed web app).

## Phase 2 — Scriptable (prettier, free app)

1. Install **Scriptable** from the App Store.
2. New script → paste the contents of `gary-widget.scriptable.js` → name it "Gary".
3. Home Screen: add a **Scriptable** widget (medium = Ask/Photo/Inbox buttons;
   small = Ask). Long-press it → **Edit Widget** → Script: "Gary".
4. Lock Screen: add a **Scriptable** circular widget → Script: "Gary".
```

- [ ] **Step 2: Commit**

```bash
git add deploy/ios/README.md
git commit -m "docs(ios): Shortcuts + Scriptable on-device setup steps"
```

- [ ] **Step 3: User builds the four Shortcuts and places them** (on-device; cannot be automated)

---

## Task 6: Phase 2 — Scriptable widget script

**Files:**
- Create: `deploy/ios/gary-widget.scriptable.js`

- [ ] **Step 1: Write the widget script**

Create `deploy/ios/gary-widget.scriptable.js`:

```js
// Gary launcher widget for Scriptable. Paste into a new Scriptable script named
// "Gary", then add a Scriptable Home/Lock-screen widget pointing at it.
// Per-element tap URLs (medium/large) deep-link into the PWA's ?action= modes.
// Requires Tailscale connected on the device.

const BASE = "https://bespin.bicolor-triceratops.ts.net:8443";
const url = (a) => `${BASE}/?action=${a}`;

const BG = new Color("#1e1f22");
const FG = new Color("#ffffff");
const MUTED = new Color("#9aa0a6");

function button(row, glyph, label, action) {
  const cell = row.addStack();
  cell.layoutVertically();
  cell.centerAlignContent();
  cell.url = url(action);               // per-element tap target (medium/large)
  const g = cell.addText(glyph);
  g.font = Font.systemFont(22);
  g.centerAlignText();
  cell.addSpacer(2);
  const t = cell.addText(label);
  t.font = Font.mediumSystemFont(11);
  t.textColor = MUTED;
  t.centerAlignText();
}

function buildMedium() {
  const w = new ListWidget();
  w.backgroundColor = BG;
  const header = w.addText("Gary");
  header.font = Font.boldSystemFont(15);
  header.textColor = FG;
  w.addSpacer(8);
  const row = w.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  button(row, "\u{1F4AC}", "Ask", "new");      // speech balloon
  row.addSpacer();
  button(row, "\u{1F4F7}", "Photo", "photo");  // camera
  row.addSpacer();
  button(row, "\u{1F4E5}", "Inbox", "inbox");  // inbox tray
  row.addSpacer();
  return w;
}

function buildSmall() {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.url = url("new");                   // whole-widget tap
  w.addSpacer();
  const g = w.addText("\u{1F4AC}");
  g.font = Font.systemFont(26);
  g.centerAlignText();
  w.addSpacer(4);
  const t = w.addText("Ask Gary");
  t.font = Font.mediumSystemFont(12);
  t.textColor = FG;
  t.centerAlignText();
  w.addSpacer();
  return w;
}

function buildAccessory() {           // Lock Screen circular/inline: one tap target
  const w = new ListWidget();
  w.url = url("new");
  const g = w.addText("\u{1F4AC}");
  g.font = Font.systemFont(20);
  g.centerAlignText();
  return w;
}

let widget;
const fam = config.widgetFamily;      // small|medium|large|accessoryCircular|...
if (fam === "medium" || fam === "large") widget = buildMedium();
else if (fam && fam.startsWith("accessory")) widget = buildAccessory();
else widget = buildSmall();

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  widget.presentMedium();             // preview when run inside Scriptable
}
Script.complete();
```

- [ ] **Step 2: Syntax-check the script**

Run: `node --check deploy/ios/gary-widget.scriptable.js`
Expected: no output, exit 0. (Scriptable globals like `ListWidget`/`config` are runtime-provided; `--check` validates syntax only, which is all we can verify off-device.)

- [ ] **Step 3: Commit**

```bash
git add deploy/ios/gary-widget.scriptable.js
git commit -m "feat(ios): Scriptable launcher widget (Ask/Photo/Inbox + Lock circular)"
```

- [ ] **Step 4: User installs Scriptable, pastes the script, places widgets** (on-device; cannot be automated)

---

## Done when

- `node scripts/test/deeplink.test.mjs` passes and `node --check` is clean on all three JS files.
- The four `…/?action=` routes return 200 and, after deploy, the user confirms each lands in the right mode on the `:8443` origin.
- The user has the Shortcuts (Phase 1) and/or Scriptable widget (Phase 2) on their Home/Lock screen launching Gary.
