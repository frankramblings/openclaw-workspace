// mention-picker.js: DOM-facing widget.
//
// Original scope (per this project's convention, document-editor.test.js):
// test the exported decision entry point (handleMentionKeydown) against a
// minimal fake <textarea>, not the apiGet-driven fetch/render internals
// (those were meant to be exercised indirectly through mention-core.test.js's
// insertMention/renderPickerHtml coverage).
//
// Fix round 1, Important 4: that left the widget's actual DOM wiring --
// keyboard branching once a picker is genuinely open, click-to-pick,
// outside-click close, and the stale-response guard -- with no real
// behavioral coverage at all (the three tests below all exit at
// handleMentionKeydown's very first guard). `__mentionPickerTestHooks`
// (exported by mention-picker.js for this purpose only -- app.js's real
// public interface is still just `handleMentionKeydown`/`initMentionPicker`,
// unchanged) opens a seam onto the private onInput/onClick/closeMenu/open
// state so this file can drive the widget the way a real composer would,
// with a stubbed fetch and Node's node:test mock timers standing in for the
// debounce (same pattern as chat-pipeline-tails.test.js).
import { test, mock } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.window = {};
// readyState 'complete': by the time a real browser evaluates this module,
// DOMContentLoaded has already fired for any script tag added after the
// initial parse -- the self-boot guard below (mirrors live/jobs.js:401-408)
// must call initMentionPicker() immediately in that case rather than register
// a DOMContentLoaded listener that will now never fire. addedListeners
// records every addEventListener call so the test below can tell which path
// the guard took. This simple object (no real listener dispatch) is
// sufficient for every test in this file: the Fix-round-1 tests below drive
// the widget directly through __mentionPickerTestHooks instead of relying on
// document.addEventListener actually delivering events.
const addedListeners = [];
globalThis.document = {
  readyState: 'complete',
  querySelector: () => null,
  addEventListener(type) { addedListeners.push(type); },
  activeElement: null,
};

const { handleMentionKeydown, __mentionPickerTestHooks } =
  await import('../redesign/live/mention-picker.js');
const { runtime } = await import('../redesign/live/runtime.js');

test('self-boot: readyState "complete" at import time means initMentionPicker already ran, not deferred to DOMContentLoaded', () => {
  // The module-level self-boot guard ran synchronously when this file
  // imported the module (readyState was 'complete' above), so it took the
  // immediate-init branch and registered its real listeners right away --
  // proven by 'input' already being in addedListeners without needing a
  // DOMContentLoaded event to fire (this Node test never dispatches one).
  assert.ok(addedListeners.includes('input'));
  assert.ok(!addedListeners.includes('DOMContentLoaded'));
});

function fakeTa(value, selectionStart) {
  const state = { value, selectionStart };
  return {
    get value() { return state.value; },
    set value(v) { state.value = v; },
    get selectionStart() { return state.selectionStart; },
    getAttribute: (n) => (n === 'data-focus' ? 'draft' : null),
    setSelectionRange: (s) => { state.selectionStart = s; },
    closest: () => null,
    focus() {},
  };
}

test('handleMentionKeydown: returns false when no picker is open', () => {
  const ta = fakeTa('hello', 5);
  assert.strictEqual(handleMentionKeydown({ key: 'Enter' }, ta), false);
});

test('handleMentionKeydown: returns false for a key it does not own even while open is falsy', () => {
  const ta = fakeTa('hello', 5);
  assert.strictEqual(handleMentionKeydown({ key: 'a' }, ta), false);
});

test('handleMentionKeydown: tolerates a null textarea', () => {
  assert.strictEqual(handleMentionKeydown({ key: 'Enter' }, null), false);
});

// ============================================================================
// Fix round 1 -- real widget behavior, via __mentionPickerTestHooks
// ============================================================================

// A minimal DOM node good enough for this module's own usage of it:
// className-based matches()/closest()/querySelector(), a real parent/child
// tree (so removeChild actually detaches, which the detached-menu test
// below depends on), and insertAdjacentHTML that parses just enough of
// renderPickerHtml's/ERROR_HTML's fixed output shape to build `.mention-row`
// children -- plus a captured `.html` string so tests can assert on the
// exact copy painted (e.g. telling the error state's text apart from the
// empty-results state's).
class FakeNode {
  constructor(tag, cls = '') {
    this.tag = tag;
    this.className = cls;
    this.children = [];
    this.parentNode = null;
    this._attrs = {};
    this.html = '';
  }
  matches(sel) {
    return sel.split(',').map((s) => s.trim()).some((s) => {
      if (!s.startsWith('.')) return false;
      const cls = s.slice(1);
      return (' ' + this.className + ' ').includes(' ' + cls + ' ');
    });
  }
  closest(sel) {
    let n = this;
    while (n) { if (n.matches(sel)) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) {
    const stack = [...this.children];
    while (stack.length) {
      const n = stack.shift();
      if (n.matches(sel)) return n;
      stack.push(...n.children);
    }
    return null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    if (c.parentNode === this) c.parentNode = null;
  }
  getAttribute(n) { return this._attrs[n] ?? null; }
  setAttribute(n, v) { this._attrs[n] = v; }
  insertAdjacentHTML(_pos, html) {
    const outer = new FakeNode('div', 'mention-menu');
    outer.html = html;
    const rowRe = /<div class="([^"]*)" data-mention-idx="(\d+)">/g;
    let m;
    while ((m = rowRe.exec(html))) {
      const row = new FakeNode('div', m[1]);
      row.setAttribute('data-mention-idx', m[2]);
      outer.appendChild(row);
    }
    this.appendChild(outer);
    return outer;
  }
}

function makeTa(value, selectionStart, focus = 'draft', model = 'draft') {
  const node = new FakeNode('textarea');
  node.setAttribute('data-focus', focus);
  node.setAttribute('data-model', model);
  const state = { value, selectionStart };
  Object.defineProperty(node, 'value', {
    get: () => state.value,
    set: (v) => { state.value = v; },
  });
  Object.defineProperty(node, 'selectionStart', {
    get: () => state.selectionStart,
  });
  node.setSelectionRange = (s) => { state.selectionStart = s; };
  node.focus = () => {};
  return node;
}

const jsonRes = (obj) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const drain = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

// Opens a token, elapses the debounce, and drains the fetch -- the setup
// every test below starts from.
async function openWithResults(results, ta = makeTa('@a', 2)) {
  const hooks = __mentionPickerTestHooks;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(jsonRes({ results }));
  const wrap = new FakeNode('div', 'composer-wrap');
  wrap.appendChild(ta);
  hooks.onInput({ target: ta });
  mock.timers.tick(120);
  await drain();
  globalThis.fetch = savedFetch;
  return { wrap, ta };
}

test('handleMentionKeydown: ArrowDown/ArrowUp wrap around the item list', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ta } = await openWithResults([
      { kind: 'note', id: 'n1', title: 'Alpha' },
      { kind: 'note', id: 'n2', title: 'Beta' },
      { kind: 'document', id: 'd1', title: 'Gamma' },
    ]);
    assert.strictEqual(hooks.getOpenState().items.length, 3);
    assert.strictEqual(hooks.getOpenState().highlighted, 0);
    assert.strictEqual(handleMentionKeydown({ key: 'ArrowUp' }, ta), true);
    assert.strictEqual(hooks.getOpenState().highlighted, 2, 'ArrowUp from the first item wraps to the last');
    assert.strictEqual(handleMentionKeydown({ key: 'ArrowDown' }, ta), true);
    assert.strictEqual(hooks.getOpenState().highlighted, 0, 'ArrowDown from the last item wraps to the first');
  } finally {
    mock.timers.reset();
    hooks.closeMenu();
  }
});

test('handleMentionKeydown: Enter commits the highlighted item into the textarea value and caret, returns true', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ta } = await openWithResults([{ kind: 'note', id: 'n1', title: 'Alpha' }]);
    assert.strictEqual(handleMentionKeydown({ key: 'Enter' }, ta), true);
    assert.strictEqual(ta.value, '@[Alpha](note:n1) ');
    assert.strictEqual(ta.selectionStart, ta.value.length);
    assert.strictEqual(hooks.getOpenState(), null, 'the picker closes after a commit');
  } finally {
    mock.timers.reset();
    hooks.closeMenu();
  }
});

test('handleMentionKeydown: Enter with an empty result list closes and returns false, inserting nothing', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ta } = await openWithResults([]);
    const before = ta.value;
    assert.strictEqual(handleMentionKeydown({ key: 'Enter' }, ta), false);
    assert.strictEqual(ta.value, before, 'nothing to pick means nothing is inserted');
    assert.strictEqual(hooks.getOpenState(), null);
  } finally {
    mock.timers.reset();
    hooks.closeMenu();
  }
});

test('handleMentionKeydown: Escape closes the picker and returns true', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ta } = await openWithResults([{ kind: 'note', id: 'n1', title: 'Alpha' }]);
    assert.strictEqual(handleMentionKeydown({ key: 'Escape' }, ta), true);
    assert.strictEqual(hooks.getOpenState(), null);
  } finally {
    mock.timers.reset();
    hooks.closeMenu();
  }
});

test('onClick: a row click picks; a click on the open textarea does not close; a click inside the menu\'s own chrome does not close; any other click closes', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { wrap, ta } = await openWithResults([{ kind: 'note', id: 'n1', title: 'Groceries' }]);
    assert.ok(wrap.querySelector('.mention-menu'));

    hooks.onClick({ target: ta });
    assert.ok(wrap.querySelector('.mention-menu'), 'clicking back into the open textarea must not close the menu');

    const menuEl = wrap.querySelector('.mention-menu');
    hooks.onClick({ target: menuEl });
    assert.ok(wrap.querySelector('.mention-menu'), "clicking the menu's own padding must not close it (Fix round 1, Minor)");

    const outside = new FakeNode('button', 'send-btn');
    hooks.onClick({ target: outside });
    assert.strictEqual(wrap.querySelector('.mention-menu'), null, 'a click outside the picker closes it');
    assert.strictEqual(hooks.getOpenState(), null);

    // Reopen and pick via a row click.
    ta.value = '@gro';
    ta.setSelectionRange(4);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(jsonRes({ results: [{ kind: 'note', id: 'n1', title: 'Groceries' }] }));
    hooks.onInput({ target: ta });
    mock.timers.tick(120);
    await drain();
    globalThis.fetch = savedFetch;
    const row = wrap.querySelector('.mention-row');
    assert.ok(row);
    hooks.onClick({ target: row });
    assert.strictEqual(ta.value, '@[Groceries](note:n1) ');
    assert.strictEqual(wrap.querySelector('.mention-menu'), null, 'the menu closes after a row pick');
  } finally {
    mock.timers.reset();
    hooks.closeMenu();
  }
});

test('stale-response guard: an earlier slow /api/palette response resolving after a later one must not overwrite it', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  const savedFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = (url) => new Promise((resolve) => { calls.push({ url: String(url), resolve }); });
    const wrap = new FakeNode('div', 'composer-wrap');
    const ta = makeTa('@a', 2);
    wrap.appendChild(ta);

    hooks.onInput({ target: ta });          // query "a"
    mock.timers.tick(120);                  // fires runQuery #1 (still pending)

    ta.value = '@ab';
    ta.setSelectionRange(3);
    hooks.onInput({ target: ta });          // query "ab", same token start
    mock.timers.tick(120);                  // fires runQuery #2 (still pending)

    assert.strictEqual(calls.length, 2, 'both debounced fetches actually fired');

    // Resolve the NEWER (second) request first.
    calls[1].resolve(jsonRes({ results: [{ kind: 'note', id: 'n2', title: 'Newer' }] }));
    await drain();
    assert.strictEqual(hooks.getOpenState().items[0].title, 'Newer');

    // The OLDER (first) request resolves late -- must be discarded, not
    // overwrite the newer, already-painted result.
    calls[0].resolve(jsonRes({ results: [{ kind: 'note', id: 'n1', title: 'Stale' }] }));
    await drain();
    assert.strictEqual(hooks.getOpenState().items[0].title, 'Newer',
      'the stale earlier response must not overwrite the newer one');
  } finally {
    mock.timers.reset();
    globalThis.fetch = savedFetch;
    hooks.closeMenu();
  }
});

test('Final review I5: a menu node removed out from under an open picker repaints and handles the key when the token is still live', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { wrap, ta } = await openWithResults([{ kind: 'note', id: 'n1', title: 'Alpha' }]);
    const menuEl = wrap.querySelector('.mention-menu');
    assert.ok(menuEl, 'sanity: the menu painted');

    // Simulate a background render() rebuilding the composer: the menu node
    // this widget owns is ripped out of the DOM directly (NOT via
    // closeMenu(), which is exactly how a wholesale root.innerHTML rebuild
    // would destroy it too) -- `open` stays armed, unaware.
    wrap.removeChild(menuEl);

    assert.strictEqual(handleMentionKeydown({ key: 'Enter' }, ta), true,
      'the key is handled, never handed to the Enter-to-send fallthrough');
    assert.strictEqual(ta.value, '@[Alpha](note:n1) ',
      'the still-live token commits into the textarea the user is typing in');
    assert.strictEqual(hooks.getOpenState(), null, 'the picker closes after the commit');
  } finally {
    mock.timers.reset();
    hooks.closeMenu();
  }
});

test('Final review I5: a detached picker that cannot repaint swallows the Enter instead of sending the half-typed token', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { wrap, ta } = await openWithResults([{ kind: 'note', id: 'n1', title: 'Alpha' }]);
    wrap.removeChild(wrap.querySelector('.mention-menu'));
    // The textarea is out of its composer wrapper too, so there is nowhere to
    // repaint: the picker must disarm AND still report the key as handled.
    wrap.removeChild(ta);

    const before = ta.value;
    assert.strictEqual(handleMentionKeydown({ key: 'Enter' }, ta), true,
      'a stale picker swallows one Enter rather than converting it into a send');
    assert.strictEqual(ta.value, before, 'nothing was inserted');
    assert.strictEqual(hooks.getOpenState(), null, 'the stale state was cleared, not left armed');
  } finally {
    mock.timers.reset();
    hooks.closeMenu();
  }
});

test('Final review C1: a commit writes the state field the textarea binds (data-model), so the mobile composer sends the picked mention', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  const savedState = runtime.state;
  try {
    runtime.state = { draft: '@a', mdraft: 'unused' };
    // The mobile composer: focus-keyed 'mdraft', MODEL-bound to 'draft'.
    const ta = makeTa('@a', 2, 'mdraft', 'draft');
    await openWithResults([{ kind: 'note', id: 'n1', title: 'Alpha' }], ta);
    assert.strictEqual(handleMentionKeydown({ key: 'Enter' }, ta), true);
    assert.strictEqual(runtime.state.draft, ta.value,
      'send reads state.draft, so Enter must have written it');
    assert.strictEqual(runtime.state.mdraft, 'unused');

    // Same for a row click.
    runtime.state = { draft: '@a', mdraft: 'unused' };
    const ta2 = makeTa('@a', 2, 'mdraft', 'draft');
    const { wrap } = await openWithResults([{ kind: 'note', id: 'n2', title: 'Beta' }], ta2);
    hooks.onClick({ target: wrap.querySelector('.mention-row') });
    assert.strictEqual(runtime.state.draft, ta2.value);
    assert.strictEqual(runtime.state.mdraft, 'unused');
  } finally {
    runtime.state = savedState;
    mock.timers.reset();
    hooks.closeMenu();
  }
});

test('Fix round 1, Important 3: a failed /api/palette request paints a distinct "could not search" message, not "No matches"', async () => {
  const hooks = __mentionPickerTestHooks;
  hooks.closeMenu();
  mock.timers.enable({ apis: ['setTimeout'] });
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.reject(new Error('network down'));
    const wrap = new FakeNode('div', 'composer-wrap');
    const ta = makeTa('@a', 2);
    wrap.appendChild(ta);
    hooks.onInput({ target: ta });
    mock.timers.tick(120);
    await drain();
    const menuEl = wrap.querySelector('.mention-menu');
    assert.ok(menuEl, 'a menu still paints on failure, just with different copy');
    assert.match(menuEl.html, /Could not search notes/);
    assert.doesNotMatch(menuEl.html, /No matches/);
  } finally {
    mock.timers.reset();
    globalThis.fetch = savedFetch;
    hooks.closeMenu();
  }
});
