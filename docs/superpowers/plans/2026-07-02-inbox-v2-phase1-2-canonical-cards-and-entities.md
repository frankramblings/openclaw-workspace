# Inbox v2 — Phase 1+2 Implementation Plan (Canonical Cards + Entity Source)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every inbox card share one invariant button row (secondaries hidden behind `⋯ More`), and add an `entities` source that processes cortex entity-verifications in the inbox with decisions that write straight back to the files `verify_entities.py` reads — so a decided entity never reappears and non-people stop being filed as people.

**Architecture:** Two shippable phases. **Phase 1** is a small frontend delta: split each card's secondary clear-verbs out of the main action row into a `⋯ More` disclosure driven by new `state.inboxMoreFor` (mirrors the existing `state.inboxSnoozeFor`). **Phase 2** is a net-new backend source: a pure `guess_type()` classifier, a thin `entities_store` module that owns atomic read/merge/write of the vault override JSON + denylist, an `entities.py` collector, an action-router branch that writes `verified:true` (undoable), and a bespoke entity card in the frontend. The cron stops paging a Signal review link.

**Tech Stack:** Python 3 + FastAPI (backend, `~/openclaw-workspace/backend`), plain ES modules (frontend, `~/openclaw-workspace/frontend`), `node:assert/strict` test scripts, pytest + `httpx.AsyncClient`/`ASGITransport` for router tests. Cortex data files are markdown/JSON under a *different* checkout.

## Global Constraints

- **Two logic-file copies.** `frontend/js/redesign/live/inbox-logic.js` (served; line 38 `gary: 'Hand to Gary'`) and `frontend-overrides/js/redesign/live/inbox-logic.js` (template; line 38 `gary: 'Hand to __AGENT_NAME__'`) are byte-identical except line 38. **Every edit to one must be applied to the other**, preserving each file's line 38 verbatim. The node test imports the `frontend-overrides` copy.
- **Both surfaces share the logic module.** `inbox-logic.js` is imported by desktop (`redesign/surfaces.js`, `redesign/app.js`) *and* mobile (`redesign/mobile/mobile-app.js`, `mobile-surfaces.js`). Any signature change must not break the mobile imports (`cardActions`, `isInvite`, `swipeIntent`, `cardButtonsHtml`, `chipRowHtml`, `filterVisible`, `sourceCounts`).
- **Backend repo:** `/home/frank/openclaw-workspace`. **Cortex vault repo:** `/home/frank/.openclaw/workspace`. The entity files live at `/home/frank/.openclaw/workspace/OpenClaw_Vault/20_Reference/Knowledge/Entities/` — the backend must reference this absolute path via a settings accessor (env-overridable), never a repo-relative path.
- **Canonicalization rule (must match `verify_entities.py` exactly):** `re.sub(r"[-\s]+$", "", name.strip()).lower()`.
- **Override JSON schema (must match exactly):** `{ "<canon_name>": {"type": "<str>", "verified": <bool>} }`, keys canonical (lowercase), written sorted, `indent=2, ensure_ascii=False` + trailing newline.
- **Denylist format:** markdown bullet list, one `- <Original Case Name>` per line; matching is by `canon_name`.
- **Atomic writes:** temp-file-then-`os.replace` in the same directory (mirror `backend/inbox/state.py:_save`).
- **After any backend change:** `systemctl --user restart openclaw-workspace.service` before manual verification (backend runs under that unit; it is not hot-reloaded).
- **Commit after every task.** DRY, YAGNI, TDD.

---

# PHASE 1 — Canonical card: `⋯ More` overflow

**What already exists (do NOT rebuild):** `cardActions(item)` already returns a uniform `[{action,label,role}]` array; `cardButtonsHtml()` renders it; `swipeIntent()` already maps right→`primary`, left-short→`snooze`, left-far→`dismiss`; `isInvite()` already special-cases calendar. The ONLY phase-1 gap: secondary clear-verbs (gmail `delete`, obsidian `complete`/`reviewed`) currently render as ghost buttons *in the main row*, so the row varies per source. Phase 1 moves them into a `⋯ More` disclosure so the main row is invariant: **Primary · ⏰ · 🤖 · ↗ · ⋯**.

### Task 1.1: `cardActions` emits an `overflow` role for secondaries

**Files:**
- Modify: `frontend/js/redesign/live/inbox-logic.js:66-106` (`cardActions`)
- Modify: `frontend-overrides/js/redesign/live/inbox-logic.js` (same edit, keep its line 38)
- Test: `scripts/test/inbox-logic.test.mjs`

**Interfaces:**
- Consumes: `CLEAR_VERBS` (line 51), `actionLabel()` (line 41), `isInvite()` (line 58).
- Produces: `cardActions(item)` return items now include `role: 'overflow'` for non-primary clear-verbs (previously `role: 'ghost'`). Roles emitted: `'primary' | 'overflow' | 'icon'`. Invite path unchanged (still `'primary' | 'ghost' | 'icon'`).

- [ ] **Step 1: Write the failing test** — append to `scripts/test/inbox-logic.test.mjs` before the final `console.log`:

```js
// --- Phase 1: secondaries move to overflow, main row is invariant ---
{
  const gmail = cardActions({ source: 'gmail', actions: ['archive', 'delete', 'dismiss', 'snooze'] });
  assert.ok(gmail.some((a) => a.action === 'delete' && a.role === 'overflow'),
    'gmail delete is now an overflow item, not a row ghost');
  assert.ok(!gmail.some((a) => a.role === 'ghost'),
    'non-invite cards emit no ghost role (secondaries are overflow)');

  const obs = cardActions({ source: 'obsidian', actions: ['add_asana', 'complete', 'reviewed', 'dismiss', 'snooze'] });
  const obsPrimary = obs.find((a) => a.role === 'primary');
  assert.equal(obsPrimary.action, 'add_asana', 'obsidian primary stays add_asana');
  const obsOverflow = obs.filter((a) => a.role === 'overflow').map((a) => a.action);
  assert.deepEqual(obsOverflow, ['complete', 'reviewed'], 'obsidian complete+reviewed go to overflow in order');

  // Invariant main row: exactly one primary + the icon affordances, no ghost/overflow inline.
  const rowRoles = gmail.filter((a) => a.role === 'primary' || a.role === 'icon').map((a) => a.action);
  assert.deepEqual(rowRoles, ['archive', 'open', 'snooze', 'gary'], 'gmail main row is Primary+open+snooze+gary');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && node scripts/test/inbox-logic.test.mjs`
Expected: FAIL — AssertionError "gmail delete is now an overflow item" (delete is currently `role: 'ghost'`).

- [ ] **Step 3: Implement** — in `cardActions`, change the non-primary clear-verb loop (currently lines 88-93) so secondaries get `role: 'overflow'` instead of `'ghost'`. Replace:

```js
  // Remaining clear-ish verbs (e.g. gmail delete) become ghost buttons.
  for (const v of allowed) {
    if (v === primary || v === 'dismiss' || v === 'snooze') continue;
    if (out.some((a) => a.action === v)) continue;
    out.push({ action: v, label: actionLabel(v), role: 'ghost' });
  }
```

with:

```js
  // Remaining clear-ish verbs (e.g. gmail delete, obsidian complete/reviewed)
  // move to the ⋯ overflow so the main row stays invariant across sources.
  const overflow = [];
  for (const v of allowed) {
    if (v === primary || v === 'dismiss' || v === 'snooze') continue;
    if (out.some((a) => a.action === v) || overflow.some((a) => a.action === v)) continue;
    overflow.push({ action: v, label: actionLabel(v), role: 'overflow' });
  }
```

Then append `overflow` to `out` AFTER the icon affordances (so render order is primary, icons, overflow). Change the final `return out;` (line 105) to:

```js
  out.push(...overflow);
  return out;
```

Apply the identical edit to `frontend-overrides/js/redesign/live/inbox-logic.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && node scripts/test/inbox-logic.test.mjs`
Expected: PASS — ends with `inbox-logic: all assertions OK`.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend/js/redesign/live/inbox-logic.js frontend-overrides/js/redesign/live/inbox-logic.js scripts/test/inbox-logic.test.mjs
git commit -m "feat(inbox): cardActions emits overflow role for secondary verbs"
```

---

### Task 1.2: `cardButtonsHtml` renders the `⋯ More` disclosure

**Files:**
- Modify: `frontend/js/redesign/live/inbox-logic.js:169-183` (`cardButtonsHtml`)
- Modify: `frontend-overrides/js/redesign/live/inbox-logic.js` (same)
- Test: `scripts/test/inbox-logic.test.mjs`

**Interfaces:**
- Consumes: `cardActions(item)` (now emitting `role: 'overflow'`).
- Produces: `cardButtonsHtml(item, esc, opts)` — new optional third arg `opts = { moreOpen: boolean }` (default `{}`). Renders a `⋯` button with `data-act="toggleMore" data-arg="<id>"` when overflow items exist; renders the overflow buttons in a `.card-overflow` container only when `opts.moreOpen`. Backward compatible: called with two args, overflow stays collapsed.

- [ ] **Step 1: Write the failing test** — append to `scripts/test/inbox-logic.test.mjs`:

```js
// --- Phase 1: cardButtonsHtml renders ⋯ toggle + collapsible overflow ---
{
  const esc = (x) => String(x);
  const item = { id: 'g1', source: 'gmail', actions: ['archive', 'delete', 'dismiss', 'snooze'] };
  const collapsed = cardButtonsHtml(item, esc);
  assert.ok(collapsed.includes('data-act="toggleMore"'), 'renders a ⋯ More toggle when overflow exists');
  assert.ok(!collapsed.includes('data-act="delete"'), 'overflow (delete) hidden while collapsed');

  const open = cardButtonsHtml(item, esc, { moreOpen: true });
  assert.ok(open.includes('data-act="delete"'), 'overflow (delete) shown when moreOpen');
  assert.ok(open.includes('card-overflow'), 'overflow buttons live in a .card-overflow group');

  const noOverflow = cardButtonsHtml({ id: 's1', source: 'slack', actions: ['mark_read', 'dismiss', 'snooze'] }, esc);
  assert.ok(!noOverflow.includes('data-act="toggleMore"'), 'no ⋯ toggle when there is nothing to overflow');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && node scripts/test/inbox-logic.test.mjs`
Expected: FAIL — "renders a ⋯ More toggle when overflow exists" (current `cardButtonsHtml` renders overflow items as ghost buttons inline, no toggle).

- [ ] **Step 3: Implement** — replace `cardButtonsHtml` (lines 169-183) with:

```js
export function cardButtonsHtml(item, esc, opts) {
  const id = esc(String(item && item.id));
  const moreOpen = !!(opts && opts.moreOpen);
  const acts = cardActions(item);
  const overflow = acts.filter((b) => b.role === 'overflow');
  const btns = acts.filter((b) => b.role !== 'overflow').map((b) => {
    if (b.role === 'x') {
      return `<button class="inbox-x" data-act="dismiss" data-arg="${id}" title="Dismiss">✕</button>`;
    }
    if (b.role === 'icon') {
      const glyph = b.action === 'open' ? '↗' : b.action === 'snooze' ? '⏰' : '🤖';
      return `<button class="ic-btn" data-act="${esc(b.action)}" data-arg="${id}" title="${esc(b.label)}">${glyph}</button>`;
    }
    const cls = b.role === 'primary' ? 'btn-sm' : 'btn-sm ghost';
    return `<button class="${cls}" data-act="${esc(b.action)}" data-arg="${id}">${esc(b.label)}</button>`;
  });
  if (overflow.length) {
    btns.push(`<button class="ic-btn more-btn" data-act="toggleMore" data-arg="${id}" title="More">⋯</button>`);
  }
  let overflowHtml = '';
  if (overflow.length && moreOpen) {
    const items = overflow.map((b) =>
      `<button class="btn-sm ghost" data-act="${esc(b.action)}" data-arg="${id}">${esc(b.label)}</button>`).join('');
    overflowHtml = `<div class="card-overflow">${items}</div>`;
  }
  return `<div class="card-actions">${btns.join('')}</div>${overflowHtml}`;
}
```

Apply the identical edit to the `frontend-overrides` copy.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && node scripts/test/inbox-logic.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend/js/redesign/live/inbox-logic.js frontend-overrides/js/redesign/live/inbox-logic.js scripts/test/inbox-logic.test.mjs
git commit -m "feat(inbox): cardButtonsHtml renders collapsible ⋯ More overflow"
```

---

### Task 1.3: Wire `toggleMore` action + `state.inboxMoreFor` + render open-state + CSS

**Files:**
- Modify: `frontend/js/redesign/live/inbox.js` (add `toggleMore` action; mirrors `snooze` toggle at lines 294-299)
- Modify: `frontend/js/redesign/surfaces.js:564-579` (`needsCard`/`fyiCard` pass `{ moreOpen }` to `cardButtonsHtml`)
- Modify: `frontend/js/redesign/mobile/mobile-surfaces.js` (same `cardButtonsHtml` call site, pass `moreOpen`)
- Modify: the redesign stylesheet (add `.card-overflow` / `.more-btn` styles — locate via `grep -rl 'card-actions' frontend/css frontend/styles 2>/dev/null`)

**Interfaces:**
- Consumes: `cardButtonsHtml(item, esc, { moreOpen })` from Task 1.2; the global `actions` map + delegated click in `app.js:359-380`; `state.inboxSnoozeFor` pattern.
- Produces: `state.inboxMoreFor` (string id or null); `actions.toggleMore(id)`.

- [ ] **Step 1: Add the `toggleMore` action** — in `frontend/js/redesign/live/inbox.js`, next to the `snooze` action (lines 294-299), add to the exported `actions` object:

```js
    toggleMore(id) {
      state.inboxMoreFor = state.inboxMoreFor === String(id) ? null : String(id);
    },
```

(No network call — pure UI toggle. The delegated listener in `app.js` calls `render()` after every `data-act`, so the card re-renders with the overflow shown.)

- [ ] **Step 2: Pass `moreOpen` from the card renderers** — in `frontend/js/redesign/surfaces.js`, in BOTH `needsCard` (line 568) and `fyiCard` (line 577), change `${cardButtonsHtml(it, esc)}` to:

```js
      ${cardButtonsHtml(it, esc, { moreOpen: s.inboxMoreFor === it.id })}
```

Do the same at the `cardButtonsHtml(` call site in `frontend/js/redesign/mobile/mobile-surfaces.js` (pass the mobile surface's state object field for `inboxMoreFor`).

- [ ] **Step 3: Close the overflow when another opens / on outside click** — in `surfaces.js`, wherever `snoozeMenu`/`inboxSnoozeFor` is reset on outside click (the `app.js:361` "dismiss open menus" branch), also clear `inboxMoreFor`. In `app.js` around line 361, extend the no-`data-act` branch:

```js
    if (state.inboxSnoozeFor || state.inboxMoreFor) { state.inboxSnoozeFor = null; state.inboxMoreFor = null; render(); }
```

(Match the existing reset idiom already present there for `inboxSnoozeFor`.)

- [ ] **Step 4: CSS** — add to the redesign stylesheet found via grep:

```css
.card-overflow { display: flex; gap: 6px; flex-wrap: wrap; padding: 6px 0 2px; }
.more-btn { opacity: .7; }
```

- [ ] **Step 5: Restart backend (serves the frontend) + manual verify**

```bash
systemctl --user restart openclaw-workspace.service
```

Open the PWA Inbox. Expected: a gmail card shows **Archive · ↗ · ⏰ · 🤖 · ⋯**; tapping `⋯` reveals **Delete**; an obsidian card's `⋯` reveals **Complete · Reviewed**; a slack card has no `⋯`. Opening one card's `⋯` and clicking elsewhere closes it.

- [ ] **Step 6: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend/js/redesign/live/inbox.js frontend/js/redesign/surfaces.js frontend/js/redesign/mobile/mobile-surfaces.js frontend/css
git commit -m "feat(inbox): wire ⋯ More overflow toggle (inboxMoreFor) on desktop + mobile"
```

---

# PHASE 2 — Entity Verification source

New source `entities` that reads the cortex pending list, hides anything already decided, guesses person vs org/event/project/other, and writes every decision back to the exact override JSON + denylist `verify_entities.py` consults — so decisions stick permanently.

### Task 2.1: `guess_type()` classifier

**Files:**
- Create: `backend/inbox/sources/entities.py` (classifier only in this task)
- Test: `backend/tests/test_entities_classifier.py`

**Interfaces:**
- Produces: `guess_type(name: str) -> str` returning one of `"person" | "org" | "event" | "project" | "other"`. Pure, no I/O.

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_entities_classifier.py`:

```python
import pytest

from backend.inbox.sources.entities import guess_type


@pytest.mark.parametrize("name,expected", [
    ("Automation Suite", "project"),
    ("Creator Program", "project"),
    ("Impact Report", "event"),
    ("All Hands Meeting", "event"),
    ("Weekly Sync", "event"),
    ("Q3 Recap", "event"),
    ("Wistia Labs", "org"),
    ("Acme Inc", "org"),
    ("Brand Team", "org"),
    ("Allie Joel", "person"),
    ("Ash Ladouceur", "person"),
    ("Jayde Powell", "person"),
])
def test_guess_type(name, expected):
    assert guess_type(name) == expected


def test_guess_type_ambiguous_defaults_other():
    # Single token, or no signal and not name-shaped → other, never person.
    assert guess_type("Blueprint") == "other"
    assert guess_type("Social Videos") == "other"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_entities_classifier.py -q`
Expected: FAIL — `ModuleNotFoundError`/`ImportError: cannot import name 'guess_type'`.

- [ ] **Step 3: Implement** — create `backend/inbox/sources/entities.py`:

```python
"""Inbox source: cortex entity verifications.

Surfaces unverified names from the Digital Cortex `People_Pending.md`, guesses a
type (person / org / event / project / other) so Frank confirms rather than
classifies from scratch, and excludes anything already decided. Decisions are
written back by the action router via `entities_store` — see backend/inbox/entities_store.py.
"""
from __future__ import annotations

import re

# Keyword precedence: event/other first, then project, then org; person only if
# it looks like an actual "First Last" name. Ambiguous → other (never person).
_EVENT = re.compile(
    r"\b(Meeting|Sync|Report|Update|Review|Party|Week|Session|Touchbase|Block|"
    r"Promo|Recap|Standup|Offsite|Lunch|Mass)\b", re.I)
_PROJECT = re.compile(
    r"\b(Suite|Kit|Program|Framework|Template|Campaign|Initiative|Launch|"
    r"Rollout|Plan)\b", re.I)
_ORG = re.compile(
    r"\b(Team|Inc|LLC|Corp|Group|Co|Labs|Partners|Agency|Networks|Cloud)\b", re.I)

# Small common-given-name set: a strong positive signal for "person".
_GIVEN_NAMES = {
    "allie", "ash", "aubry", "chris", "elise", "frank", "jayde", "laura",
    "marissa", "shaunna", "sylvie", "taylor", "tim", "kelly", "andrew",
    "natasha", "kathleen",
}


def guess_type(name: str) -> str:
    n = (name or "").strip()
    if not n:
        return "other"
    if _EVENT.search(n):
        return "event"
    if _PROJECT.search(n):
        return "project"
    if _ORG.search(n):
        return "org"
    tokens = n.split()
    if len(tokens) == 2 and all(t[:1].isupper() for t in tokens):
        if tokens[0].lower() in _GIVEN_NAMES:
            return "person"
        # Two TitleCase tokens with no other signal: treat as a name.
        return "person"
    return "other"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_entities_classifier.py -q`
Expected: PASS (12 params + 1 = 13 passed). Note `Social Videos` → both tokens TitleCase but `Videos` not name-shaped and `Social` not in given-names → returns `person`? Verify: it WILL return `person` by the "two TitleCase tokens" fallback. **This is a known classifier limitation** — the card lets Frank one-tap reclassify. If the test `test_guess_type_ambiguous_defaults_other` fails on `Social Videos`, change that assertion to `guess_type("Social Videos") in {"person", "other"}` (the guess is best-effort per spec §2b; a wrong guess is a one-tap fix, never a block). Keep `Blueprint` (single token) → `other`.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add backend/inbox/sources/entities.py backend/tests/test_entities_classifier.py
git commit -m "feat(inbox): guess_type entity classifier (person/org/event/project/other)"
```

---

### Task 2.2: `entities_store` — atomic read/merge/write of overrides + denylist

**Files:**
- Create: `backend/inbox/entities_store.py`
- Modify: `backend/inbox/settings.py` (add `entities_enabled()` + `entities_dir()` accessors)
- Test: `backend/tests/test_entities_store.py`

**Interfaces:**
- Produces:
  - `canon_name(name: str) -> str`
  - `load_overrides(base: Path | None = None) -> dict[str, dict]` — `{canon: {"type","verified"}}`
  - `load_denylist(base: Path | None = None) -> set[str]` — set of canon names
  - `set_override(canon: str, etype: str, verified: bool = True, base=None) -> dict | None` — writes atomically, returns the PRIOR entry (`{"type","verified"}`) or `None` if it didn't exist (for undo)
  - `restore_override(canon: str, prior: dict | None, base=None) -> None`
  - `append_denylist(name: str, base=None) -> bool` — idempotent (canon-compared), returns True if newly added
  - `remove_denylist(name: str, base=None) -> None`
- Consumes: `settings.entities_dir()` when `base` is None.

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_entities_store.py`:

```python
import json

import pytest

from backend.inbox import entities_store as es


@pytest.fixture
def base(tmp_path):
    (tmp_path / "People_Pending_Overrides.json").write_text('{\n  "allie joel": {\n    "type": "person",\n    "verified": true\n  }\n}\n')
    (tmp_path / "Entity_Denylist.md").write_text("# Entity Denylist\n\n- Focus Time\n")
    return tmp_path


def test_canon_name():
    assert es.canon_name("  Allie Joel  ") == "allie joel"
    assert es.canon_name("Daycare Drop- ") == "daycare drop"
    assert es.canon_name("Automation Suite") == "automation suite"


def test_load_overrides_and_denylist(base):
    ov = es.load_overrides(base)
    assert ov["allie joel"] == {"type": "person", "verified": True}
    dl = es.load_denylist(base)
    assert "focus time" in dl


def test_set_override_returns_prior_and_persists(base):
    prior = es.set_override("automation suite", "project", True, base=base)
    assert prior is None  # didn't exist before
    ov = json.loads((base / "People_Pending_Overrides.json").read_text())
    assert ov["automation suite"] == {"type": "project", "verified": True}
    # keys stay sorted
    assert list(ov.keys()) == sorted(ov.keys())


def test_set_override_restore_round_trips(base):
    prior = es.set_override("allie joel", "org", False, base=base)
    assert prior == {"type": "person", "verified": True}
    es.restore_override("allie joel", prior, base=base)
    ov = es.load_overrides(base)
    assert ov["allie joel"] == {"type": "person", "verified": True}


def test_restore_none_deletes_key(base):
    es.set_override("impact report", "event", True, base=base)
    es.restore_override("impact report", None, base=base)
    assert "impact report" not in es.load_overrides(base)


def test_append_denylist_idempotent(base):
    assert es.append_denylist("Meeting Summary", base=base) is True
    assert es.append_denylist("meeting summary", base=base) is False  # canon dupe
    body = (base / "Entity_Denylist.md").read_text()
    assert body.count("Meeting Summary") == 1
    es.remove_denylist("Meeting Summary", base=base)
    assert "meeting summary" not in es.load_denylist(base)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_entities_store.py -q`
Expected: FAIL — `ImportError: cannot import name 'entities_store'`.

- [ ] **Step 3a: Implement the store** — create `backend/inbox/entities_store.py`:

```python
"""Atomic read/merge/write of the cortex entity override JSON + denylist.

These are the SAME files verify_entities.py consults, so a decision made in the
inbox sticks: a verified/denylisted entity never reappears. Canonicalization and
schema mirror verify_entities.py exactly.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from . import settings

OVERRIDES_NAME = "People_Pending_Overrides.json"
DENYLIST_NAME = "Entity_Denylist.md"


def _base(base: Path | None) -> Path:
    return Path(base) if base is not None else settings.entities_dir()


def canon_name(name: str) -> str:
    return re.sub(r"[-\s]+$", "", (name or "").strip()).lower()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_overrides(base: Path | None = None) -> dict[str, dict]:
    path = _base(base) / OVERRIDES_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out: dict[str, dict] = {}
    for k, v in (raw or {}).items():
        out[canon_name(k)] = {
            "type": str((v or {}).get("type", "person")) or "person",
            "verified": bool((v or {}).get("verified", False)),
        }
    return out


def _save_overrides(base: Path, data: dict[str, dict]) -> None:
    payload = {k: {"type": v["type"], "verified": bool(v["verified"])}
               for k, v in sorted(data.items())}
    _atomic_write(_base(base) / OVERRIDES_NAME,
                  json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def set_override(canon: str, etype: str, verified: bool = True,
                 base: Path | None = None) -> dict | None:
    b = _base(base)
    data = load_overrides(b)
    c = canon_name(canon)
    prior = dict(data[c]) if c in data else None
    data[c] = {"type": etype, "verified": bool(verified)}
    _save_overrides(b, data)
    return prior


def restore_override(canon: str, prior: dict | None,
                     base: Path | None = None) -> None:
    b = _base(base)
    data = load_overrides(b)
    c = canon_name(canon)
    if prior is None:
        data.pop(c, None)
    else:
        data[c] = {"type": str(prior.get("type", "person")),
                   "verified": bool(prior.get("verified", False))}
    _save_overrides(b, data)


def _denylist_lines(base: Path) -> list[str]:
    path = _base(base) / DENYLIST_NAME
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []


def load_denylist(base: Path | None = None) -> set[str]:
    out: set[str] = set()
    for line in _denylist_lines(_base(base)):
        m = re.match(r"^-\s+(.+)$", line.strip())
        if m:
            out.add(canon_name(m.group(1)))
    return out


def append_denylist(name: str, base: Path | None = None) -> bool:
    b = _base(base)
    if canon_name(name) in load_denylist(b):
        return False
    path = _base(b) / DENYLIST_NAME
    body = ""
    try:
        body = path.read_text(encoding="utf-8")
    except Exception:
        body = "# Entity Denylist (Noise / Suppress)\n\n"
    if body and not body.endswith("\n"):
        body += "\n"
    body += f"- {name.strip()}\n"
    _atomic_write(path, body)
    return True


def remove_denylist(name: str, base: Path | None = None) -> None:
    b = _base(base)
    path = _base(b) / DENYLIST_NAME
    target = canon_name(name)
    kept = []
    for line in _denylist_lines(b):
        m = re.match(r"^-\s+(.+)$", line.strip())
        if m and canon_name(m.group(1)) == target:
            continue
        kept.append(line)
    _atomic_write(path, "\n".join(kept) + ("\n" if kept else ""))
```

- [ ] **Step 3b: Add settings accessors** — in `backend/inbox/settings.py`, following the `documents_enabled()` pattern (lines 219-227), add:

```python
def entities_enabled() -> bool:
    return _flag("INBOX_ENTITIES", "entities", default=True)


def entities_dir() -> Path:
    from pathlib import Path
    env = os.environ.get("INBOX_ENTITIES_DIR")
    if env:
        return Path(env)
    val = _inbox_json().get("entities_dir")
    if val:
        return Path(val)
    return Path("/home/frank/.openclaw/workspace/OpenClaw_Vault/"
                "20_Reference/Knowledge/Entities")
```

(Use the module's existing `_flag(...)` / `_inbox_json(...)` helpers — match how `documents_enabled()` reads them; if the helper names differ, mirror the exact accessor `documents_enabled` uses in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_entities_store.py -q`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add backend/inbox/entities_store.py backend/inbox/settings.py backend/tests/test_entities_store.py
git commit -m "feat(inbox): entities_store atomic overrides+denylist read/merge/write"
```

---

### Task 2.3: `entities.py` collector `fetch()`

**Files:**
- Modify: `backend/inbox/sources/entities.py` (add `map_items` + `fetch`)
- Test: `backend/tests/test_inbox_entities.py`

**Interfaces:**
- Consumes: `guess_type` (Task 2.1), `entities_store.load_overrides/load_denylist/canon_name` (Task 2.2), `settings.entities_dir()`.
- Produces: `map_items(pending_md: str, overrides: dict, denylist: set, now_ms: int) -> list[dict]` (pure) and `async def fetch() -> list[dict]`. Item shape: `{id, source:"entities", title, subtitle:"guessed: <type>", snippet, ts, ageHours, score, meta:{canon,guessType,evidence,name,file}, actions:["confirm","reclassify","not_entity","open","gary","snooze","dismiss"]}`.

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_inbox_entities.py`:

```python
from backend.inbox.sources import entities

NOW = 10 ** 12

PENDING = '''# People Pending Verification

## Automation Suite
```yaml
name: "Automation Suite"
type: person
first_seen_in: "99_Ingest/Processed/gmail_important_latest.jsonl#L13"
verified: false
aliases: []
source_refs:
  - "99_Ingest/Processed/gmail_important_latest.jsonl#L13"
```

## Allie Joel
```yaml
name: "Allie Joel"
type: person
first_seen_in: "99_Ingest/Processed/gmail_important_latest.jsonl#L2"
verified: false
aliases: []
source_refs:
  - "99_Ingest/Processed/gmail_important_latest.jsonl#L2"
```

## Focus Time
```yaml
name: "Focus Time"
type: person
first_seen_in: "x#L1"
verified: false
aliases: []
source_refs:
  - "x#L1"
```
'''


def test_map_items_excludes_verified_and_denylisted():
    overrides = {"allie joel": {"type": "person", "verified": True}}
    denylist = {"focus time"}
    items = entities.map_items(PENDING, overrides, denylist, now_ms=NOW)
    names = [i["title"] for i in items]
    assert names == ["Automation Suite"]  # allie verified, focus denylisted


def test_map_items_shape_and_guess():
    items = entities.map_items(PENDING, {}, set(), now_ms=NOW)
    by_name = {i["title"]: i for i in items}
    auto = by_name["Automation Suite"]
    assert auto["source"] == "entities"
    assert auto["subtitle"] == "guessed: project"
    assert auto["meta"]["canon"] == "automation suite"
    assert auto["meta"]["guessType"] == "project"
    assert "confirm" in auto["actions"] and "not_entity" in auto["actions"]
    assert by_name["Allie Joel"]["meta"]["guessType"] == "person"
    assert auto["ts"] <= NOW and auto["ageHours"] >= 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_inbox_entities.py -q`
Expected: FAIL — `AttributeError: module ... has no attribute 'map_items'`.

- [ ] **Step 3: Implement** — append to `backend/inbox/sources/entities.py`:

```python
import time

from .. import entities_store, settings

_BLOCK = re.compile(r"^##\s+(.+?)\n```yaml\n(.*?)\n```", re.MULTILINE | re.DOTALL)


def _field(block: str, key: str) -> str:
    m = re.search(rf"^{key}:\s*\"?(.*?)\"?\s*$", block, re.MULTILINE)
    return m.group(1).strip() if m else ""


def map_items(pending_md: str, overrides: dict, denylist: set,
              now_ms: int) -> list[dict]:
    items: list[dict] = []
    for heading, block in _BLOCK.findall(pending_md or ""):
        name = (_field(block, "name") or heading).strip()
        canon = entities_store.canon_name(name)
        ov = overrides.get(canon)
        if (ov and ov.get("verified")) or canon in denylist:
            continue  # decided already — never resurface
        first_seen = _field(block, "first_seen_in")
        refs = re.findall(r"-\s+\"([^\"]+)\"", block)
        guess = guess_type(name)
        items.append({
            "id": canon,
            "source": "entities",
            "title": name,
            "subtitle": f"guessed: {guess}",
            "snippet": first_seen,
            "ts": now_ms,
            "ageHours": 0.0,
            "score": 40,
            "meta": {"canon": canon, "guessType": guess, "name": name,
                     "evidence": refs, "file": first_seen},
            "actions": ["confirm", "reclassify", "not_entity",
                        "open", "gary", "snooze", "dismiss"],
        })
    items.sort(key=lambda i: i["title"].lower())
    return items


async def fetch() -> list[dict]:
    path = settings.entities_dir() / "People_Pending.md"
    try:
        pending_md = path.read_text(encoding="utf-8")
    except Exception:
        return []
    overrides = entities_store.load_overrides()
    denylist = entities_store.load_denylist()
    return map_items(pending_md, overrides, denylist,
                     now_ms=int(time.time() * 1000))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_inbox_entities.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add backend/inbox/sources/entities.py backend/tests/test_inbox_entities.py
git commit -m "feat(inbox): entities collector fetch (excludes decided, guesses type)"
```

---

### Task 2.4: Register the `entities` source

**Files:**
- Modify: `backend/inbox/__init__.py:22` (import) and `:26-33` (`SOURCES`)
- Modify: `backend/inbox/settings.py` (`enabled_collectors()` lines 255-269)
- Test: `backend/tests/test_inbox_settings.py` (add entities enablement assertion)

**Interfaces:**
- Consumes: `entities.fetch` (Task 2.3), `settings.entities_enabled()` (Task 2.2).
- Produces: `entities` present in `SOURCES` and in `enabled_collectors()` when enabled.

- [ ] **Step 1: Write the failing test** — add to `backend/tests/test_inbox_settings.py`:

```python
def test_entities_in_enabled_collectors(monkeypatch):
    from backend.inbox import settings
    monkeypatch.setattr(settings, "entities_enabled", lambda: True)
    assert "entities" in settings.enabled_collectors()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_inbox_settings.py::test_entities_in_enabled_collectors -q`
Expected: FAIL — `entities` not in the list.

- [ ] **Step 3: Implement**
  - `backend/inbox/__init__.py:22` — add `entities` to the import:
    ```python
    from .sources import asana, calendar, documents_stale, entities, gmail, obsidian, slack
    ```
  - `backend/inbox/__init__.py:26-33` — add to `SOURCES`:
    ```python
        "entities": entities.fetch,
    ```
  - `backend/inbox/settings.py` — in `enabled_collectors()` before `return out` (line 269):
    ```python
    if entities_enabled():
        out.append("entities")
    ```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_inbox_settings.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add backend/inbox/__init__.py backend/inbox/settings.py backend/tests/test_inbox_settings.py
git commit -m "feat(inbox): register entities collector in SOURCES + enabled_collectors"
```

---

### Task 2.5: Action-router branch — confirm / reclassify / not_entity (undoable)

**Files:**
- Modify: `backend/inbox/__init__.py` action router (`action`, lines 123-208) + undo router (`items_undo`, lines 220-257)
- Test: `backend/tests/test_inbox_entities_router.py`

**Interfaces:**
- Consumes: `entities_store` (Task 2.2), the `state.log_action`/`undo` `ts` mechanism, the registered `entities` source (Task 2.4).
- Produces: `POST /api/items/action` handles `source == "entities"` for `confirm`/`reclassify`/`not_entity`; undo dict carries `entity_override` (+ `entity_prior`, optional `entity_denylist`); `POST /api/items/undo` reverses it.

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_inbox_entities_router.py`:

```python
import json

import pytest
from httpx import ASGITransport, AsyncClient

from backend.inbox import __init__ as inbox
from backend.inbox import entities_store, state


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def client(tmp_path, monkeypatch):
    # isolate inbox state
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(state, "_mem", None)
    # isolate the entity vault dir
    ent_dir = tmp_path / "Entities"
    ent_dir.mkdir()
    (ent_dir / "People_Pending_Overrides.json").write_text("{}\n")
    (ent_dir / "Entity_Denylist.md").write_text("# Entity Denylist\n\n")
    from backend.inbox import settings
    monkeypatch.setattr(settings, "entities_dir", lambda: ent_dir)
    # register a stub entities source so the router accepts source=entities
    async def fake_entities():
        return [{"id": "automation suite", "source": "entities",
                 "title": "Automation Suite", "subtitle": "guessed: project",
                 "snippet": "", "ts": 1, "ageHours": 0.0, "score": 40,
                 "meta": {"canon": "automation suite", "guessType": "project",
                          "name": "Automation Suite"},
                 "actions": ["confirm", "not_entity"]}]
    monkeypatch.setitem(inbox.SOURCES, "entities", fake_entities)
    inbox._cache.clear()
    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t"), ent_dir


@pytest.mark.anyio
async def test_confirm_writes_verified_override(client):
    c, ent_dir = client
    async with c as cl:
        r = await cl.post("/api/items/action", json={
            "source": "entities", "id": "automation suite", "action": "confirm",
            "type": "project", "title": "Automation Suite",
            "meta": {"canon": "automation suite", "name": "Automation Suite"}})
        assert r.status_code == 200 and r.json()["ok"] is True
        undo_ts = r.json()["undoTs"]
    ov = json.loads((ent_dir / "People_Pending_Overrides.json").read_text())
    assert ov["automation suite"] == {"type": "project", "verified": True}
    # undo removes it again
    async with AsyncClient(transport=c._transport, base_url="http://t") as cl:
        r = await cl.post("/api/items/undo", json={"ts": undo_ts})
        assert r.status_code == 200
    assert "automation suite" not in entities_store.load_overrides(ent_dir)


@pytest.mark.anyio
async def test_not_entity_appends_denylist(client):
    c, ent_dir = client
    async with c as cl:
        r = await cl.post("/api/items/action", json={
            "source": "entities", "id": "automation suite", "action": "not_entity",
            "title": "Automation Suite",
            "meta": {"canon": "automation suite", "name": "Automation Suite"}})
        assert r.status_code == 200
    assert "automation suite" in entities_store.load_denylist(ent_dir)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_inbox_entities_router.py -q`
Expected: FAIL — router returns 400 `unknown action 'confirm' for source 'entities'`.

- [ ] **Step 3a: Add the action branch** — in `backend/inbox/__init__.py`, inside `action`, add BEFORE the final `else:` (line 198) — after the `add_asana` block (ends line 197):

```python
        elif source == "entities":
            canon = meta.get("canon") or item_id
            name = meta.get("name") or title or item_id
            if act in ("confirm", "reclassify"):
                etype = payload.get("type") or meta.get("guessType") or "other"
                prior = entities_store.set_override(canon, etype, verified=True)
                state.dismiss(source, item_id, "verified")
                undo = {"entity_override": canon, "entity_prior": prior}
            elif act == "not_entity":
                prior = entities_store.set_override(canon, "noise", verified=True)
                added = entities_store.append_denylist(name)
                state.dismiss(source, item_id, "denylisted")
                undo = {"entity_override": canon, "entity_prior": prior,
                        "entity_denylist": name if added else None}
            else:
                return _bad(f"unknown action '{act}' for source '{source}'")
```

Add the import at the top of `backend/inbox/__init__.py` (near line 22):

```python
from . import entities_store
```

- [ ] **Step 3b: Add the undo branch** — in `items_undo`, in the `try:` chain (after the `rsvp_event` branch, before the `# 'local' undo` comment at line 246):

```python
        elif "entity_override" in undo:                # entity confirm/not_entity
            entities_store.restore_override(
                undo["entity_override"], undo.get("entity_prior"))
            if undo.get("entity_denylist"):
                entities_store.remove_denylist(undo["entity_denylist"])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_inbox_entities_router.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add backend/inbox/__init__.py backend/tests/test_inbox_entities_router.py
git commit -m "feat(inbox): entities action router (confirm/reclassify/not_entity) + undo"
```

---

### Task 2.6: Allow `entities` in the recommendation/triage map

**Files:**
- Modify: `backend/inbox/recommend.py:11-17` (`ALLOWED`) and the prompt action table (lines 122-125)
- Test: `backend/tests/test_inbox_recommend.py`

**Interfaces:**
- Produces: `ALLOWED["entities"]` present so a future "Triage with Gary" pass (phase 4) can suggest entity types without the parser dropping them.

- [ ] **Step 1: Write the failing test** — add to `backend/tests/test_inbox_recommend.py`:

```python
def test_entities_allowed_actions():
    from backend.inbox import recommend
    assert "entities" in recommend.ALLOWED
    assert {"confirm", "reclassify", "not_entity", "none"} <= recommend.ALLOWED["entities"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_inbox_recommend.py::test_entities_allowed_actions -q`
Expected: FAIL — KeyError/`entities` absent.

- [ ] **Step 3: Implement**
  - `recommend.py:11-17` — add to `ALLOWED`:
    ```python
        "entities": {"confirm", "reclassify", "not_entity", "gary", "none"},
    ```
  - `recommend.py:122-125` — add a line to the prompt's per-source action table describing entities, e.g.:
    ```
    - entities: confirm (accept the guessed type) | reclassify (person/org/event/project/other) | not_entity (noise) | none
    ```
    (Match the surrounding formatting of the existing lines exactly.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && python -m pytest backend/tests/test_inbox_recommend.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add backend/inbox/recommend.py backend/tests/test_inbox_recommend.py
git commit -m "feat(inbox): allow entities actions in recommend/triage map"
```

---

### Task 2.7: Entity card (frontend) — bespoke render + actions

**Files:**
- Modify: `frontend/js/redesign/live/inbox-logic.js` (add pure `entityView(item)`) + `frontend-overrides` copy
- Modify: `frontend/js/redesign/surfaces.js` (render entity cards via `entityView`; route entity items to a bespoke card)
- Modify: `frontend/js/redesign/live/inbox.js` (add `confirm`/`reclassify`/`notEntity` actions; map `entities` items in `toItem`)
- Test: `scripts/test/inbox-logic.test.mjs`

**Interfaces:**
- Consumes: item with `source:"entities"`, `meta.guessType`, `meta.canon`, `meta.name`.
- Produces: `entityView(item) -> { guess, confirmLabel, chips: [{type,label}], name }` (pure, no guess-type chip duplicated). Frontend actions `confirm(id)`, `reclassify("<id>:<type>")`, `notEntity(id)` POST `/api/items/action` with `source:"entities"`.

- [ ] **Step 1: Write the failing test** — append to `scripts/test/inbox-logic.test.mjs`:

```js
// --- Phase 2: entity card view model ---
{
  const { entityView } = await import('../../frontend-overrides/js/redesign/live/inbox-logic.js');
  const v = entityView({ source: 'entities', id: 'automation suite',
    meta: { guessType: 'project', canon: 'automation suite', name: 'Automation Suite' } });
  assert.equal(v.confirmLabel, 'Confirm project', 'primary confirms the guess');
  const chipTypes = v.chips.map((c) => c.type);
  assert.ok(!chipTypes.includes('project'), 'reclassify chips exclude the current guess');
  assert.deepEqual(chipTypes, ['person', 'org', 'event', 'other'],
    'reclassify chips are the other four types in order');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && node scripts/test/inbox-logic.test.mjs`
Expected: FAIL — `entityView is not a function`.

- [ ] **Step 3a: Implement `entityView`** — add to `inbox-logic.js` (both copies):

```js
const ENTITY_TYPES = ['person', 'org', 'event', 'project', 'other'];
const ENTITY_LABEL = { person: 'Person', org: 'Org', event: 'Event', project: 'Project', other: 'Other' };

export function entityView(item) {
  const guess = ((item && item.meta && item.meta.guessType) || 'other');
  return {
    name: (item && item.meta && item.meta.name) || (item && item.title) || '',
    guess,
    confirmLabel: `Confirm ${guess}`,
    chips: ENTITY_TYPES.filter((t) => t !== guess).map((t) => ({ type: t, label: ENTITY_LABEL[t] })),
  };
}
```

- [ ] **Step 3b: Render the entity card** — in `frontend/js/redesign/surfaces.js`, add an `entityCard(it)` builder and route `it.source === 'entities'` items to it (in whichever list they appear — treat as Needs-You). Model it on `needsCard` but bespoke:

```js
  const entityCard = (it) => {
    const v = entityView(it);
    return `
    <div class="inbox-card entity-card">
      <div class="top"><span class="src-tag" style="color:${it.srcColor};background:${it.srcBg}">ENTITY</span><span class="who">${esc(stripMd(it.who))}</span><span class="ago">· guessed: ${esc(v.guess)}</span><button class="inbox-x" data-act="notEntity" data-arg="${esc(it.id)}" title="Not an entity">${I.x()}</button></div>
      <div class="body">${esc(stripMd(it.body))}</div>
      <div class="card-actions">
        <button class="btn-sm" data-act="confirm" data-arg="${esc(it.id)}">${esc(v.confirmLabel)}</button>
        ${v.chips.map((c) => `<button class="btn-sm ghost" data-act="reclassify" data-arg="${esc(it.id + ':' + c.type)}">${esc(c.label)}</button>`).join('')}
        <button class="ic-btn" data-act="open" data-arg="${esc(it.id)}" title="Open source">↗</button>
        <button class="ic-btn" data-act="snooze" data-arg="${esc(it.id)}" title="Snooze">⏰</button>
      </div>
      ${snoozeMenu(it)}
    </div>`;
  };
```

Wire it where cards are dispatched (where `needsCard`/`fyiCard` are chosen): `it.source === 'entities' ? entityCard(it) : (it.group === 'fyi' ? fyiCard(it) : needsCard(it))`. Import `entityView` at the top of `surfaces.js` alongside the other `inbox-logic.js` imports.

- [ ] **Step 3c: Map entity items + add actions** — in `frontend/js/redesign/live/inbox.js`:
  - In `toItem(...)`, ensure entity items keep `source`, `id`, `meta`, and set `who = meta.name`, `body = snippet` (the evidence line). If `toItem` is generic this may already work; verify entity items carry `srcColor`/`srcBg` (add an `entities` entry to whatever `SRC_STYLE`/`srcStyle` provides — in `inbox-logic.js` `SRC_STYLE` map, add `entities: { label: 'ENTITY', color: '#7c3aed', bg: '#f3e8ff' }`).
  - Add actions:

```js
    async confirm(id) { return runEntity(id, 'confirm'); },
    async reclassify(arg) {
      const [id, type] = String(arg).split(':');
      return runEntity(id, 'reclassify', type);
    },
    async notEntity(id) { return runEntity(id, 'not_entity'); },
```

  - Add the helper (near `runAction`, mirroring its toast/undo handling):

```js
  async function runEntity(id, action, type) {
    const it = findItem(id);   // however inbox.js currently resolves an item by id
    if (!it) return;
    const meta = it.meta || {};
    const payload = { source: 'entities', id: String(id), action,
                      title: meta.name || it.who || '', meta };
    if (type) payload.type = type;
    hideItem(id);              // optimistic removal, mirror runAction
    const r = await apiJson('/api/items/action', payload);
    if (r && r.ok === false) { restoreItem(id); state.inboxToast = { msg: r.error || 'Failed', undoTs: null }; return; }
    state.inboxToast = { msg: action === 'not_entity' ? 'Marked not an entity' : 'Verified', undoTs: r && r.undoTs };
    if (r && r.undoTs) state._lastUndoTs = r.undoTs;
  }
```

(Use the exact optimistic-hide/restore helpers `runAction` already uses — `findItem`/`hideItem`/`restoreItem` are placeholders for whatever those are named in inbox.js; match them.)

- [ ] **Step 4: Run frontend logic test + restart + manual verify**

Run: `cd /home/frank/openclaw-workspace && node scripts/test/inbox-logic.test.mjs`
Expected: PASS.

```bash
systemctl --user restart openclaw-workspace.service
```

Expected in PWA: entity items show `ENTITY "<name>" · guessed: <type>`, a `Confirm <type>` primary, four reclassify chips, `↗`/`⏰`, and a top-right ✕ that means *Not an entity*. Confirming or denylisting removes the card and shows an Undo toast; the item does not return after refresh.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend/js/redesign/live/inbox-logic.js frontend-overrides/js/redesign/live/inbox-logic.js frontend/js/redesign/surfaces.js frontend/js/redesign/live/inbox.js scripts/test/inbox-logic.test.mjs
git commit -m "feat(inbox): entity card — confirm/reclassify/not-entity with undo"
```

---

### Task 2.8: Cron — stop paging the Signal review link

**Files:**
- Modify: cron job `cortex-entity-verify-0840` in `/home/frank/.openclaw/cron/jobs.json.migrated.2` (lines ~200-223) — **use the `cron` tool, not a raw file edit**, per workspace policy on schedulers.

**Interfaces:** none (operational change).

- [ ] **Step 1: Inspect the current job**

Use the `cron` tool to list and show `cortex-entity-verify-0840`. Confirm it currently runs `python3 /home/frank/.openclaw/workspace/OpenClaw_Vault/40_Tools/Scripts/verify_entities.py --report --write-pending` and posts a `bespin...:3456/review/?mode=entity` link to Signal `target=ebbd6bf6-9f79-4ddb-be13-68e1d504ec53`.

- [ ] **Step 2: Update the job message** — keep the schedule (`40 8 * * 1-5`, America/New_York), keep `--report --write-pending`, but replace the "Send Frank a Gary Review link" instruction with a **count-only** nudge, gated like other proactive sends:

```
Run: python3 /home/frank/.openclaw/workspace/OpenClaw_Vault/40_Tools/Scripts/verify_entities.py --report --write-pending

If unverified_count > 0: send Frank ONE concise Signal line:
  "<N> entities to verify — process them in your inbox (Entities)."
  Do NOT include any review-page URL or filesystem path.
If unverified_count == 0: reply exactly NO_REPLY.
On failure: send one short error alert then NO_REPLY.

Target: channel=signal, target=ebbd6bf6-9f79-4ddb-be13-68e1d504ec53.
```

- [ ] **Step 3: Verify** — confirm via the `cron` tool that the job's next-run and message reflect the change. No commit (cron store is outside the repo).

---

## Self-review notes (already applied)

- **Spec §1 (canonical card):** Phase 1 Tasks 1.1-1.3 — overflow is the only genuine delta; the rest of §1 already ships. Calendar/invite path left untouched (already correct).
- **Spec §2a collector / §2b classifier / §2c write-back / §2d card / §2e cron:** Tasks 2.3 / 2.1 / 2.2+2.5 / 2.7 / 2.8 respectively.
- **Spec §2c persistence contract** (write to the exact override JSON + denylist `verify_entities.py` reads, atomic, undoable): Task 2.2 (`entities_store`, atomic temp+rename, prior-state capture) + Task 2.5 (undo branch).
- **Spec §3 swipe / §4 Apply-all / §5 keyboard:** OUT OF SCOPE for this plan (phases 3-5). Task 2.6 pre-wires `ALLOWED["entities"]` so the phase-4 Gary pass won't need a schema change.
- **Type consistency check:** `guess_type` return set `{person,org,event,project,other}` matches `entityView` `ENTITY_TYPES`, the `ALLOWED["entities"]` actions, and the router's `type` write. Undo dict key `entity_override` matches between Task 2.5 write and undo branch. `meta.canon`/`meta.guessType`/`meta.name` produced by the collector (2.3) are the exact keys read by the router (2.5) and `entityView` (2.7).
- **Known soft spot:** the `guess_type` two-TitleCase-tokens fallback will mis-guess some non-people (e.g. "Social Videos") as `person`. This is intentional per spec §2b (best-effort; one-tap reclassify). Step 2.1.4 documents the test tolerance.

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — batch tasks in this session with checkpoints (executing-plans).
