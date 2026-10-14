# Pinned Sections Implementation Plan

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** Add a PINNED section at the top of the conversation sidebar/drawer and the model picker, with pinned items also appearing in their normal sections.

**Architecture:** Thread grouping stays a pure function in `thread-groups.js` (sections may now overlap). Both renderers consume the same group list and use a shared `dedupeGroups` helper while filtering. Model pins live server-side in `.data/settings.json` behind two new endpoints; the frontend keeps an ordered list of composite ids in `state.live.pinnedModels`.

**Tech Stack:** Plain ES modules (`frontend-overrides/js/redesign`), node:test, FastAPI + pytest.

Design: `docs/plans/2026-10-14-pinned-sections-design.md` (approved 2026-10-14).

---

## Ground rules (all tasks)

- Repo: `~/openclaw-workspace`. Edit only `frontend-overrides/`, `backend/`, `docs/`. Never edit `frontend/` (generated).
- Run JS tests with a glob: `node --test frontend-overrides/js/__tests__/*.test.js` (baseline: 1238 pass, 0 fail). Passing the directory fails.
- Run one JS file: `node --test frontend-overrides/js/__tests__/<file>.test.js`.
- Backend: `python3 -m pytest backend/tests/<file> -q` (baseline for `test_model_pair_guard.py`: 17 pass).
- Composite model id separator is `·` (`MODEL_SEP`). Row ids look like `claude-cli·claude-opus-4-8`.
- Commit after every green task. Do not use em dashes in any copy or comments you write.
- Do not touch `switcher.js` (Cmd+K) or `frankfm`/unrelated files. Repo has an unrelated untracked `docs/compute-offload-proposal.md`; never `git add -A`.

---

### Task 1: Thread groups logic (overlapping sections)

**Files:**
- Modify: `frontend-overrides/js/redesign/thread-groups.js`
- Test: `frontend-overrides/js/__tests__/thread-groups.test.js`

**Step 1: Write the failing tests.** Append to `thread-groups.test.js`:

```js
const secIds = (g, kind, label) => (g.find((x) => x.kind === kind && (label == null || x.label === label)) || { rows: [] }).rows.map((r) => r.id);

test('PINNED is first and holds every starred thread, whatever else it belongs to', () => {
  const sessions = [
    S('plain', { important: true }),
    S('inproj', { important: true, folder: 'p1' }),
    S('opn', { important: true, opened: NOW - H }),
    S('nope'),
    S('gone', { important: true, archived: true }),
  ];
  const g = build({ sessions, projects: [{ id: 'p1', name: 'P' }] });
  assert.equal(g[0].kind, 'pinned');
  assert.equal(g[0].label, '★ PINNED');
  assert.deepEqual(ids(g[0]).sort(), ['inproj', 'opn', 'plain']);
  assert.equal(g[0].meta.count, 3);
});

test('a pinned thread in an archived project still shows in PINNED', () => {
  const g = build({ sessions: [S('a', { important: true, folder: 'pa' })], projects: [{ id: 'pa', name: 'A', archived: true }] });
  assert.deepEqual(kinds(g), ['pinned']);
});

test('no pinned threads means no PINNED section', () => {
  assert.ok(!kinds(build({ sessions: [S('a')] })).includes('pinned'));
});

test('an OPEN unfiled thread also appears in its date bucket', () => {
  const g = build({ sessions: [S('o', { opened: NOW - H, updated: NOW - H })] });
  assert.deepEqual(secIds(g, 'open'), ['o']);
  assert.deepEqual(secIds(g, 'recent', 'TODAY'), ['o']);
});

test('an OPEN filed thread also appears in its project, but never in a date bucket', () => {
  const g = build({ sessions: [S('f', { opened: NOW - H, updated: NOW - H, folder: 'p1' })], projects: [{ id: 'p1', name: 'P' }] });
  assert.deepEqual(secIds(g, 'open'), ['f']);
  assert.deepEqual(g.find((x) => x.kind === 'project').rows.map((r) => r.id), ['f']);
  assert.ok(!kinds(g).includes('recent'));
});

test('a pinned unfiled thread appears in PINNED and in its date bucket', () => {
  const g = build({ sessions: [S('p', { important: true, updated: NOW - H })] });
  assert.deepEqual(secIds(g, 'pinned'), ['p']);
  assert.deepEqual(secIds(g, 'recent', 'TODAY'), ['p']);
});

test('no thread appears twice inside one section', () => {
  const sessions = [S('a', { important: true, opened: NOW, folder: 'p1' }), S('b', { important: true, opened: NOW })];
  const g = build({ sessions, projects: [{ id: 'p1', name: 'P' }] });
  for (const sec of g) assert.equal(new Set(ids(sec)).size, ids(sec).length, `${sec.kind} has duplicates`);
});
```

Then fix the three existing tests that assert the old exclusivity:

1. `'OPEN takes threads opened within 48h...'`: replace the last two lines (`const rest = ...` and its `assert.deepEqual`) with:
   ```js
   const recentIds = g.filter((x) => x.kind === 'recent').flatMap((x) => x.rows.map((r) => r.id));
   assert.deepEqual(recentIds.sort(), ['act', 'plain', 'q', 'recent', 'run', 'stale'], 'unfiled OPEN threads also sit in their date bucket; archived stay hidden');
   ```
2. `'RECENT keeps the date buckets and the pinned shelf...'`: expected kinds become `['pinned', 'recent', 'recent', 'recent']`, and add `assert.deepEqual(secIds(g, 'recent', 'LAST WEEK'), ['pin']);` (pin is 100h old, so LAST WEEK on a Tuesday). Keep the other assertions.
3. `'the same session never appears twice and inputs are not mutated'`: expected kinds become `['pinned', 'open', 'project']`, `g[2].rows.length` is `1` (project row now includes the OPEN thread), `g[2].meta.count` is `1`, and the JSON mutation check stays. Rename the test to `'a thread appears once per section and inputs are not mutated'`.

**Step 2: Run, confirm failure.**
Command: `node --test frontend-overrides/js/__tests__/thread-groups.test.js`
Expected: FAIL on the new tests and the three edited ones.

**Step 3: Implement** in `thread-groups.js`, function `buildThreadGroups`:

1. Right after `const list = ...` and `projById`, before the OPEN block, add the PINNED group and push it first:
   ```js
   // PINNED: every starred thread, regardless of OPEN/project membership.
   // Sections overlap on purpose (design 2026-10-14): a thread shows in every
   // section it qualifies for. Pinning is explicit, so an archived project
   // does not hide a pinned thread here.
   const groups = [];
   const pinnedRows = list.filter((s) => s.important).map((s) => rowOf(s, activeId, live));
   if (pinnedRows.length) groups.push({ kind: 'pinned', label: '★ PINNED', rows: pinnedRows, meta: { count: pinnedRows.length } });
   ```
   and change the later `const groups = [];` (just before `if (keep.length)`) to nothing (reuse the one above).
2. Delete `const openIds = ...`.
3. In the PROJECTS loop: `if (!p) { unfiled.push(s); continue; }` and `bucket.rows.push(s);` (drop both `openIds` conditions).
4. Delete the old pinned-shelf block (`const pinned = unfiled.filter(...)` through its `groups.push`), and drop `if (s.important) continue;` from the date-bucket loop.
5. Update the header comment: sections overlap; PINNED leads.

**Step 4: Run, confirm pass.**
Command: `node --test frontend-overrides/js/__tests__/thread-groups.test.js`
Expected: PASS (all).

**Step 5: Fix fallout.** Run `node --test frontend-overrides/js/__tests__/*.test.js`. Any other test that asserted a thread appears in exactly one section (likely `sidebar-render-kinds`, `mobile-drawer-kinds`, `redesign-queued-dot`, `thread-switching`) must be updated to the new overlapping rule, not loosened. Expected final: 0 failures.

**Step 6: Commit.**
`git add frontend-overrides/js/redesign/thread-groups.js frontend-overrides/js/__tests__ && git commit -m "feat(groups): PINNED leads; sections overlap (pinned/open/project/date)"`

---

### Task 2: dedupeGroups helper (filtering)

**Files:**
- Modify: `frontend-overrides/js/redesign/thread-groups.js`
- Test: `frontend-overrides/js/__tests__/thread-groups.test.js`

**Step 1: Failing test** (add import `dedupeGroups` to the existing import line):

```js
test('dedupeGroups keeps the first occurrence of each id and drops emptied groups', () => {
  const groups = [
    { kind: 'pinned', label: 'P', rows: [{ id: 'a' }, { id: 'b' }], meta: {} },
    { kind: 'open', label: 'OPEN', rows: [{ id: 'a' }], meta: { count: 1 } },
    { kind: 'recent', label: 'TODAY', rows: [{ id: 'b' }, { id: 'c' }], meta: {} },
  ];
  const out = dedupeGroups(groups);
  assert.deepEqual(out.map((g) => g.rows.map((r) => r.id)), [['a', 'b'], ['c']]);
  assert.equal(groups[1].rows.length, 1, 'input untouched');
});
```

**Step 2:** Run the file. Expected: FAIL (`dedupeGroups is not a function`).

**Step 3: Implement** (export from `thread-groups.js`):

```js
// Filtering lists a match once: first section in display order wins. Groups
// emptied by the de-dupe are dropped. Pure; does not mutate its input.
export function dedupeGroups(groups) {
  const seen = new Set();
  const out = [];
  for (const g of (Array.isArray(groups) ? groups : [])) {
    const rows = (g.rows || []).filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    if (rows.length) out.push({ ...g, rows });
  }
  return out;
}
```

**Step 4:** Run the file. Expected: PASS.

**Step 5:** `git add ... && git commit -m "feat(groups): dedupeGroups for filtered lists"`

---

### Task 3: Desktop sidebar renderer

**Files:**
- Modify: `frontend-overrides/js/redesign/surfaces.js` (`convListBody`, around lines 142-212)
- Modify: `frontend-overrides/js/redesign/live/chat.js` (`toggleConvMenu`, ~line 4095)
- Test: `frontend-overrides/js/__tests__/sidebar-render-kinds.test.js`

**Behavior:**
- `pinned` group renders a header like OPEN: `<div class="conv-group pinned{top}"><span class="sect-label">★ PINNED</span><span class="sect-count">N</span></div>`. Use `g.meta.count` (rendered row count while filtering, like OPEN).
- The `top` class goes to whichever group is first (`gi === 0`); today's code already does that, but verify no code assumes OPEN is first.
- Each rendered row gets `data-sect="<key>"` where key is `pinned`, `open`, `project:<meta.id>` or `recent:<label>`. `convRow(r, sectKey)`.
- Menu: `chat.rowMenuSect` holds the key the menu was opened from. A row is `menu-open` and renders `convMenu` only when `rowMenuOpen === r.id && (rowMenuSect == null || rowMenuSect === sectKey)`. (`null` keeps old tests and any programmatic opener working.)
- `toggleConvMenu(id, e)`: derive the section from the click: `const sect = e && e.target && e.target.closest ? (e.target.closest('[data-sect]') || {}).getAttribute?.('data-sect') : null`. Toggle logic: if `rowMenuOpen === id && rowMenuSect === sect` close (both null), else set both. Reset `rowMenuSect = null` wherever `rowMenuOpen = null` is set in chat.js (`grep -n "rowMenuOpen = null"`).
- `⌥N` slot badge and close button already key off `r.slot`, which only OPEN rows carry; leave as is and add a test.
- Filter: when `q` is set, run `dedupeGroups(groups2)` after the title filter (import from `./thread-groups.js`). Alpha sort is applied after, per section.

**Step 1: Write the failing tests** in `sidebar-render-kinds.test.js`. Reuse its fixtures; add a second fixture set:

```js
const pinSessions = [
  { id: 'a', name: 'Alpha Pinned Open', created: 1, updated: NOW - 1000, opened: NOW - 1000, important: true },
  { id: 'b', name: 'Beta Pinned Filed', created: 1, updated: NOW - 2000, opened: null, important: true, folder: 'projA' },
];
function pinState(extra = {}) {
  const groups = buildThreadGroups({ sessions: pinSessions, projects, running: new Set(), notified: new Set(), queued: new Set(), now: NOW, activeId: null, expanded: new Set(['projA']) });
  return { convFilter: '', convSort: 'recent', live: { projects, chat: { cwd: '/x', rowMenuOpen: null, rowMenuSect: null, projMenuOpen: null, groups, ...extra } } };
}
const count = (html, re) => (html.match(re) || []).length;

test('PINNED renders first with a count and the top class', () => {
  const html = renderChatList(pinState());
  assert.match(html, /class="conv-group pinned top"><span class="sect-label">★ PINNED<\/span><span class="sect-count">2<\/span>/);
  assert.ok(html.indexOf('PINNED') < html.indexOf('>OPEN<'));
});

test('a pinned+open thread renders in PINNED, OPEN and its date bucket', () => {
  const html = renderChatList(pinState());
  assert.equal(count(html, /data-act="selectSession" data-arg="a"/g), 3);
  assert.match(html, /data-sect="pinned"/);
  assert.match(html, /data-sect="open"/);
});

test('the row menu opens only on the section it was opened from', () => {
  const html = renderChatList(pinState({ rowMenuOpen: 'a', rowMenuSect: 'pinned' }));
  assert.equal(count(html, /class="conv-menu"/g), 1);
  const idx = html.indexOf('class="conv-menu"');
  assert.ok(html.lastIndexOf('data-sect="pinned"', idx) > html.lastIndexOf('data-sect="open"', idx));
});

test('slot badge and close button render only in OPEN', () => {
  const html = renderChatList(pinState());
  assert.equal(count(html, /class="conv-slot"/g), 1);
  assert.equal(count(html, /class="conv-close"/g), 1);
});

test('filtering lists each match once', () => {
  const html = renderChatList({ ...pinState(), convFilter: 'alpha' });
  assert.equal(count(html, /data-act="selectSession" data-arg="a"/g), 1);
});
```

(If `data-sect`'s attribute position differs from the regexes, adapt the regexes, not the intent.)

**Step 2:** `node --test frontend-overrides/js/__tests__/sidebar-render-kinds.test.js`. Expected: FAIL.

**Step 3:** Implement per Behavior. Add a `.conv-group.pinned` header branch next to the `open` branch in `header`.

**Step 4:** Run the file, then the full suite. Expected: PASS, 0 failures.

**Step 5:** `git add frontend-overrides/js && git commit -m "feat(sidebar): render PINNED section, per-section row menus, dedupe on filter"`

---

### Task 4: Mobile drawer renderer

**Files:**
- Modify: `frontend-overrides/js/redesign/mobile/mobile-sheets.js` (`convListHtml`, ~lines 85-190)
- Test: `frontend-overrides/js/__tests__/mobile-drawer-kinds.test.js` (read it first and follow its fixture style)

**Behavior:**
- `pinned` header: `<div class="m-conv-grp pinned">★ PINNED <span class="m-conv-cnt">N</span></div>` (N = rendered rows while filtering, else `meta.count`).
- Filtering applies `dedupeGroups` after the title filter.
- `hasOpen` logic for the Phase 1 RECENT fallback stays, but also treat a `pinned` group as "has something above the date buckets"? No: keep exactly as is (RECENT only when no OPEN). Do not change it.
- Long-press actions are id-based, no per-section state needed. No change to `mSelectSession`.

**Step 1: Failing tests:** (a) a pinned thread renders a `m-conv-grp pinned` header with its count and the row appears under both PINNED and its date bucket; (b) with a filter that matches it, the row renders once.
**Step 2:** Run the file. Expected: FAIL.
**Step 3:** Implement.
**Step 4:** Run the file and the full suite. Expected: PASS.
**Step 5:** `git commit -m "feat(drawer): PINNED header and filter dedupe on mobile"`

---

### Task 5: Backend pinned-models endpoints

**Files:**
- Modify: `backend/app.py` (add after `set_default_chat`, ~line 1250)
- Create: `backend/tests/test_pinned_models.py`

**Step 1: Failing tests** (`websearch._SETTINGS_FILE` is computed at import, so redirect it):

```python
import pytest
from fastapi.testclient import TestClient

from backend import websearch
from backend.app import app


@pytest.fixture(autouse=True)
def _settings(tmp_path, monkeypatch):
    monkeypatch.setattr(websearch, "_SETTINGS_FILE", tmp_path / "settings.json")


def _get(c):
    return c.get("/api/pinned-models").json()["items"]


def test_empty_by_default():
    assert _get(TestClient(app)) == []


def test_pin_adds_in_order_and_is_idempotent():
    c = TestClient(app)
    a = {"model": "claude-opus-4-8", "endpoint_id": "claude-cli", "pinned": True}
    b = {"model": "gpt-5.4-mini", "endpoint_id": "openai", "pinned": True}
    assert c.post("/api/pinned-models", json=a).status_code == 200
    assert c.post("/api/pinned-models", json=b).status_code == 200
    assert c.post("/api/pinned-models", json=a).status_code == 200
    assert _get(c) == [
        {"model": "claude-opus-4-8", "endpoint_id": "claude-cli"},
        {"model": "gpt-5.4-mini", "endpoint_id": "openai"},
    ]


def test_same_model_on_two_endpoints_are_distinct_pins():
    c = TestClient(app)
    for ep in ("claude-cli", "perplexity-web"):
        c.post("/api/pinned-models", json={"model": "claude-sonnet-4-6", "endpoint_id": ep, "pinned": True})
    assert len(_get(c)) == 2


def test_unpin_removes_only_that_pair():
    c = TestClient(app)
    for ep in ("claude-cli", "perplexity-web"):
        c.post("/api/pinned-models", json={"model": "claude-sonnet-4-6", "endpoint_id": ep, "pinned": True})
    c.post("/api/pinned-models", json={"model": "claude-sonnet-4-6", "endpoint_id": "claude-cli", "pinned": False})
    assert _get(c) == [{"model": "claude-sonnet-4-6", "endpoint_id": "perplexity-web"}]


def test_missing_model_is_400():
    r = TestClient(app).post("/api/pinned-models", json={"endpoint_id": "x", "pinned": True})
    assert r.status_code == 400


def test_pinning_does_not_require_the_endpoint_to_be_online():
    r = TestClient(app).post("/api/pinned-models", json={"model": "m", "endpoint_id": "offline-ep", "pinned": True})
    assert r.status_code == 200
```

**Step 2:** `python3 -m pytest backend/tests/test_pinned_models.py -q`. Expected: FAIL (404s).

**Step 3: Implement**

```python
def _pinned_models() -> list[dict]:
    raw = websearch.load_settings().get("pinned_models") or []
    return [
        {"model": str(p.get("model") or ""), "endpoint_id": str(p.get("endpoint_id") or "")}
        for p in raw if isinstance(p, dict) and p.get("model")
    ]


@app.get("/api/pinned-models")
async def get_pinned_models():
    """Ordered list of models pinned to the top of the model picker (pin order).
    Stored in .data/settings.json beside default_chat_model."""
    return {"items": _pinned_models()}


@app.post("/api/pinned-models")
async def set_pinned_model(payload: dict = Body(default=None)):
    """Pin or unpin one (endpoint, model) pair. Idempotent. Deliberately skips
    the offline-endpoint pair guard: pinning a model whose endpoint is down is
    fine, and unresolved pins are skipped by the picker at render time."""
    payload = payload or {}
    model = (payload.get("model") or "").strip()
    if not model:
        return JSONResponse(status_code=400, content={"error": "model required"})
    ep = (payload.get("endpoint_id") or "").strip()
    want = bool(payload.get("pinned", True))
    cur = _pinned_models()
    has = any(p["model"] == model and p["endpoint_id"] == ep for p in cur)
    if want == has:   # already in the requested state: no-op keeps pin order stable
        return {"ok": True, "items": cur}
    if want:
        items = cur + [{"model": model, "endpoint_id": ep}]
    else:
        items = [p for p in cur if not (p["model"] == model and p["endpoint_id"] == ep)]
    websearch.save_settings({"pinned_models": items})
    return {"ok": True, "items": items}
```

**Step 4:** Run the new file and `backend/tests/test_model_pair_guard.py`. Expected: PASS.

**Step 5:** `git add backend/app.py backend/tests/test_pinned_models.py && git commit -m "feat(api): /api/pinned-models"`

---

### Task 6: Pin icon and pinned-model state/actions

**Files:**
- Modify: `frontend-overrides/js/redesign/icons.js` (add `pin`)
- Modify: `frontend-overrides/js/redesign/live/chat.js` (`loadModelOptions`, new `togglePinModel`)
- Modify: `frontend-overrides/js/redesign/mobile/mobile-app.js` (add `mTogglePinModel` beside `mSetModel`, ~line 236)
- Test: `frontend-overrides/js/__tests__/redesign-icons.test.js` (icon exists), `frontend-overrides/js/__tests__/redesign-model-pins.test.js` (new, actions)

**Step 1: Failing tests.**
- Icons: `I.pin(13, true)` returns an `<svg` string; filled variant contains `fill="currentColor"`. Follow the style of the existing assertions in `redesign-icons.test.js`.
- Actions (read `redesign-model-cross-pair.test.js` first to copy how it stubs `runtime`, `apiGet`/`apiJson` and the module's actions): 
  1. `loadModelOptions` populates `state.live.pinnedModels` as `['claude-cli·claude-opus-4-8']` from `{items:[{model:'claude-opus-4-8',endpoint_id:'claude-cli'}]}`.
  2. A failed GET leaves `pinnedModels` as `[]` and does not set `modelsFailed`.
  3. `togglePinModel('claude-cli·claude-opus-4-8')` adds the id optimistically and POSTs `{model, endpoint_id, pinned:true}`; calling again POSTs `pinned:false` and removes it.
  4. When the POST rejects, the list reverts to its previous value.
  5. Ids not found in `state.live.modelList` are ignored (no POST).

**Step 2:** Run both files. Expected: FAIL.

**Step 3: Implement.**
- Icon, in `icons.js` next to `star`:
  ```js
  pin: (s = 13, filled = false) => icon('<path d="M12 17v5M9 3h6l-1 6 4 4v2H6v-2l4-4z"/>', { size: s, sw: 1.6, fill: filled ? 'currentColor' : 'none' }),
  ```
- `loadModelOptions`: after the `/api/default-chat` try block, add its sibling:
  ```js
  try {
    const pm = await apiGet('/api/pinned-models');
    state.live.pinnedModels = ((pm && pm.items) || []).map((p) => (p.endpoint_id || '') + MODEL_SEP + (p.model || ''));
    runtime.render();
  } catch (_) { state.live.pinnedModels = state.live.pinnedModels || []; }
  ```
- `togglePinModel(id)` (in the same actions object as `setDefaultModel`): resolve `item` from `state.live.modelList` (ignore if missing); `prev = (state.live.pinnedModels || []).slice()`; compute `next` (append if absent, remove if present); set `state.live.pinnedModels = next`; `runtime.render()`; `try { await apiJson('/api/pinned-models', { model: item.mid, endpoint_id: item.endpointId || '', pinned: !wasPinned }); } catch (_) { state.live.pinnedModels = prev; runtime.render(); toast('Couldn’t update the pin.'); }`. It must not call `setModel` and must not close the menu.
- `mobile-app.js`: `mTogglePinModel: (id) => { if (runtime.actions && runtime.actions.togglePinModel) runtime.actions.togglePinModel(id); },` (do not close the sheet).

**Step 4:** Run both test files and the full suite. Expected: PASS.

**Step 5:** `git commit -m "feat(models): pinned-model state, loader and toggle actions"`

---

### Task 7: Model picker rendering (desktop popover and mobile sheet)

**Files:**
- Modify: `frontend-overrides/js/redesign/surfaces.js` (`modelPopover`, ~line 438)
- Modify: `frontend-overrides/js/redesign/mobile/mobile-sheets.js` (`renderModelSheet`)
- Modify: `frontend-overrides/css/` or `frontend-overrides/redesign.css` (pin button; near `.mstar`, ~line 515) and `frontend-overrides/js/redesign/mobile/mobile.css` (near line 385)
- Test: `frontend-overrides/js/__tests__/redesign-model-picker.test.js`; new `frontend-overrides/js/__tests__/mobile-model-sheet.test.js`

**Behavior:**
- Resolve pins: `pinned = (s.live.pinnedModels || []).map((id) => modelList.find((m) => m.id === id)).filter(Boolean)` where `modelList = s.live.modelList || flatten(groups)`. Unresolved ids are skipped (not removed from storage).
- If `pinned.length`, render a first group: `<div class="model-grp"><span class="model-ep">PINNED</span></div>` plus rows via the same `row()` renderer. Mobile: `<div class="m-model-ep">PINNED</div>`.
- Every row (pinned copy and endpoint copy) gets a pin button before the default star: desktop `<span class="mpin{ on}" data-act="togglePinModel" data-arg="<id>" title="Pin to top">${I.pin(13, isPinned)}</span>`; mobile `data-act="mTogglePinModel"`. The existing wrapper `data-act="noop"` / row-level act must not fire when the pin is clicked (the star already works this way: nested `data-act` wins via `closest`).
- With zero resolved pins there is no PINNED group, so the group structure is unchanged and existing assertions that count `class="model-ep"` stay at 2. Pin buttons always render on every row (otherwise nothing could ever be pinned), so row markup gains the button; update any existing assertion that matches an entire row string.
- CSS: `.mpin` mirrors `.mstar` (hidden until row hover on desktop; `opacity:.45` always on mobile like `.m-model-row .mstar`), `.mpin.on{opacity:1;color:var(--teal)}`.
- Design note: use the provider-logo and check mark exactly as in normal rows so a selected pinned model shows its check in both places.

**Step 1: Failing tests.**
Desktop (`redesign-model-picker.test.js`, reuse its `groups`/`state` helpers; add `modelList` to the state if not present by flattening `groups`):
- With `pinnedModels: ['claude-cli·claude-sonnet-4-6']`: the first `model-ep` is `PINNED`; the Sonnet row appears twice (`data-act="setModel" data-arg="claude-cli·claude-sonnet-4-6"` count 2); the total `class="model-ep"` count is 3.
- With `pinnedModels: ['ghost·nothing']`: no PINNED header.
- Every row contains a `data-act="togglePinModel"` button; the pinned ones have the `on` class; the pin button is not nested as a `setModel` target (its own `data-arg` is the row id).
Mobile (new file; model on `model-sheet-retry.test.js` for imports and state): same three assertions against `renderModelSheet`, using `m-model-ep` and `mTogglePinModel`.

**Step 2:** Run both. Expected: FAIL.
**Step 3:** Implement.
**Step 4:** Run both and the full suite. Expected: PASS.
**Step 5:** `git commit -m "feat(picker): PINNED group and pin buttons in model popover and sheet"`

---

### Task 8: Sidebar CSS for the PINNED header

**Files:**
- Modify: `frontend-overrides/redesign.css` and `frontend-overrides/js/redesign/mobile/mobile.css`

Style `.conv-group.pinned` and `.m-conv-grp.pinned` like the existing `.conv-group.open` / `.m-conv-grp.open` (count chip included), with the gold star colour used by `.conv-fav`. No tests (visual); verified in Task 9.

Commit: `git commit -m "style: PINNED section header"`

---

### Task 9: Sync, restart, verify

1. Confirm the tree is clean for our files: `git status --short` shows only the unrelated `docs/compute-offload-proposal.md`. (Marissa's bundle sync ships committed files only.)
2. `bash scripts/sync-frontend.sh` (must exit 0; any `DRIFT` message is a failure to report, not ignore).
3. `systemctl --user restart openclaw-workspace.service`, then `systemctl --user is-active openclaw-workspace.service` prints `active`.
4. Full gates: `node --test frontend-overrides/js/__tests__/*.test.js` (0 fail) and `python3 -m pytest backend/tests/test_pinned_models.py backend/tests/test_model_pair_guard.py -q`.
5. API smoke: `curl -s localhost:8800/api/pinned-models` returns `{"items":[...]}`.
6. Browser check at desktop width and ~390px mobile width (use the browser tool; follow the stale-bundle note in `memory/topics/workspace-pwa-dev-notes.md`: hard reload, confirm the new `app.js` stamp): star a thread that is also OPEN, confirm it shows in PINNED, OPEN and its date bucket; confirm a filed thread does not show in a date bucket; open the kebab menu on the PINNED copy and confirm only that copy opens; pin a model, reload, confirm it persists and appears under both PINNED and its endpoint.
7. Remove any test pins you created through the UI (unpin via the same buttons) and unstar test threads.

No commit unless the sync produced tracked changes.

---

## Final review

After Task 9, dispatch one overall code-review pass over `git diff 8c9d4e8..HEAD` (spec: the design doc), fix findings, then use the finishing-branch step (repo is on its working branch; confirm with Frank before pushing anything).
