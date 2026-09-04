// mention-picker.js: DOM-facing widget. Per this project's convention
// (document-editor.test.js), test the exported decision entry point
// (handleMentionKeydown) against a minimal fake <textarea>, not the
// apiGet-driven fetch/render internals (those are exercised through
// mention-core.test.js's insertMention/renderPickerHtml coverage, which
// handleMentionKeydown itself delegates to).
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.window = {};
// readyState 'complete': by the time a real browser evaluates this module,
// DOMContentLoaded has already fired for any script tag added after the
// initial parse -- the self-boot guard below (mirrors live/jobs.js:401-408)
// must call initMentionPicker() immediately in that case rather than register
// a DOMContentLoaded listener that will now never fire. addedListeners
// records every addEventListener call so the test below can tell which path
// the guard took.
const addedListeners = [];
globalThis.document = {
  readyState: 'complete',
  querySelector: () => null,
  addEventListener(type) { addedListeners.push(type); },
  activeElement: null,
};

const { handleMentionKeydown } = await import('../redesign/live/mention-picker.js');

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
