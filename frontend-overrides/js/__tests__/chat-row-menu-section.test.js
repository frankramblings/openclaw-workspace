// toggleConvMenu records which sidebar section a row menu was opened from
// (a thread can render in PINNED, OPEN, a project and a date bucket at once).
// Same minimal browser shim as chat-usage.test.js.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class { close() {} };

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');

// A click event whose target sits inside a row tagged with data-sect.
const evIn = (sect) => ({ target: { closest: (sel) => (sel === '[data-sect]' && sect != null ? { getAttribute: (n) => (n === 'data-sect' ? sect : null) } : null) } });
function fresh() {
  const state = { live: { chat: { rowMenuOpen: null, rowMenuSect: null } }, chatMenuOpen: false };
  runtime.state = state;
  runtime.render = () => {};
  return state.live.chat;
}

test('opening a menu records the section it came from', () => {
  const chat = fresh();
  actions.toggleConvMenu('a', evIn('pinned'));
  assert.equal(chat.rowMenuOpen, 'a');
  assert.equal(chat.rowMenuSect, 'pinned');
});

test('clicking the same kebab again closes the menu and clears the section', () => {
  const chat = fresh();
  actions.toggleConvMenu('a', evIn('pinned'));
  actions.toggleConvMenu('a', evIn('pinned'));
  assert.equal(chat.rowMenuOpen, null);
  assert.equal(chat.rowMenuSect, null);
});

test('the same thread in another section moves the menu instead of closing it', () => {
  const chat = fresh();
  actions.toggleConvMenu('a', evIn('pinned'));
  actions.toggleConvMenu('a', evIn('open'));
  assert.equal(chat.rowMenuOpen, 'a');
  assert.equal(chat.rowMenuSect, 'open');
});

test('no event (programmatic opener) keeps the section null and still toggles', () => {
  const chat = fresh();
  actions.toggleConvMenu('a');
  assert.equal(chat.rowMenuOpen, 'a');
  assert.equal(chat.rowMenuSect, null);
  actions.toggleConvMenu('a');
  assert.equal(chat.rowMenuOpen, null);
});

test('actions that null rowMenuOpen also clear the section', async () => {
  const chat = fresh();
  actions.toggleConvMenu('a', evIn('pinned'));
  actions.toggleProjMenu('p1');
  assert.equal(chat.rowMenuOpen, null);
  assert.equal(chat.rowMenuSect, null);
});
