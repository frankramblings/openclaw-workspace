import { test } from 'node:test';
import assert from 'node:assert';
import { trapOrder, nextFocus, defaultIsFocusable, pickModal } from '../redesign/focus-trap.js';

// ---- trapOrder --------------------------------------------------------

test('trapOrder: filters a plain array with the default predicate (no DOM)', () => {
  const btn = { tagName: 'BUTTON' };
  const hiddenBtn = { tagName: 'BUTTON', hidden: true };
  const disabledInput = { tagName: 'INPUT', disabled: true };
  const link = { tagName: 'A', href: 'https://example.com' };
  const bareLink = { tagName: 'A' }; // no href — not in the tab order
  const div = { tagName: 'DIV' };
  const tabbableDiv = { tagName: 'DIV', hasAttribute: (n) => n === 'tabindex' };
  const negTabindexBtn = { tagName: 'BUTTON', tabIndex: -1 };

  const order = trapOrder([btn, hiddenBtn, disabledInput, link, bareLink, div, tabbableDiv, negTabindexBtn]);
  assert.deepEqual(order, [btn, link, tabbableDiv]);
});

test('trapOrder: an injected predicate fully overrides the default one', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const onlyOdd = (el) => el.id % 2 === 1;
  assert.deepEqual(trapOrder(items, onlyOdd), [{ id: 1 }, { id: 3 }]);
});

test('trapOrder: empty container yields an empty list', () => {
  assert.deepEqual(trapOrder([]), []);
  assert.deepEqual(trapOrder(undefined), []);
});

test('trapOrder: accepts a container exposing querySelectorAll (DOM-shaped duck type)', () => {
  const all = [{ tagName: 'BUTTON' }, { tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'hidden' }];
  const fakeContainer = { querySelectorAll: (sel) => (sel === '*' ? all : []) };
  const order = trapOrder(fakeContainer);
  assert.deepEqual(order, [all[0], all[1]]);
});

test('defaultIsFocusable: input[type=hidden] is excluded, other inputs are included', () => {
  assert.equal(defaultIsFocusable({ tagName: 'INPUT', type: 'hidden' }), false);
  assert.equal(defaultIsFocusable({ tagName: 'INPUT', type: 'email' }), true);
  assert.equal(defaultIsFocusable({ tagName: 'INPUT' }), true); // type defaults to text
});

test('defaultIsFocusable: aria-hidden elements are excluded even if otherwise focusable', () => {
  const el = { tagName: 'BUTTON', getAttribute: (n) => (n === 'aria-hidden' ? 'true' : null) };
  assert.equal(defaultIsFocusable(el), false);
});

// ---- nextFocus ----------------------------------------------------------

test('nextFocus: steps forward and wraps from the last element to the first', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(nextFocus(list, 'a', false), 'b');
  assert.equal(nextFocus(list, 'b', false), 'c');
  assert.equal(nextFocus(list, 'c', false), 'a'); // wrap-around forward
});

test('nextFocus: shift steps backward and wraps from the first element to the last', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(nextFocus(list, 'c', true), 'b');
  assert.equal(nextFocus(list, 'b', true), 'a');
  assert.equal(nextFocus(list, 'a', true), 'c'); // wrap-around backward (shift-tab off the first field)
});

test('nextFocus: current not in the list lands on the first (forward) or last (shift)', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(nextFocus(list, 'z', false), 'a');
  assert.equal(nextFocus(list, 'z', true), 'c');
  assert.equal(nextFocus(list, null, false), 'a');
  assert.equal(nextFocus(list, undefined, true), 'c');
});

test('nextFocus: a single-element list keeps returning that same element (Tab loops in place)', () => {
  const list = ['only'];
  assert.equal(nextFocus(list, 'only', false), 'only');
  assert.equal(nextFocus(list, 'only', true), 'only');
});

test('nextFocus: an empty list returns null instead of throwing', () => {
  assert.equal(nextFocus([], 'a', false), null);
  assert.equal(nextFocus(undefined, 'a', false), null);
});

test('nextFocus: object identity is what matters, not equality — mirrors real DOM elements', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const list = [a, b];
  // A structurally-identical-but-distinct object is NOT found in the list —
  // this documents that callers must pass the same reference back in
  // (exactly how document.activeElement works against a live NodeList).
  assert.equal(nextFocus(list, { id: 'a' }, false), a); // not found -> lands on first
  assert.equal(nextFocus(list, a, false), b);
});

// ---- pickModal ----------------------------------------------------------

const SURFACES = [
  { open: (s) => !!s.drawerOpen, selector: '.drawer', close: 'closeDrawer' },
  { open: (s) => !!s.sheetOpen, selector: '.sheet', close: 'closeSheet' },
  { open: (s) => !!s.readerOpen, selector: '.reader', close: 'closeReader' },
];

test('pickModal: first open surface wins, in registry (paint) order', () => {
  const all = () => true;
  assert.equal(pickModal(SURFACES, { sheetOpen: true, readerOpen: true }, all).close, 'closeSheet');
  assert.equal(pickModal(SURFACES, { drawerOpen: true, readerOpen: true }, all).close, 'closeDrawer');
});

test('pickModal: nothing open returns null', () => {
  assert.equal(pickModal(SURFACES, {}, () => true), null);
  assert.equal(pickModal([], { sheetOpen: true }, () => true), null);
  assert.equal(pickModal(undefined, {}, () => true), null);
});

test('pickModal: an open surface whose container is gone is skipped (stale state flag)', () => {
  // readerOpen outlived its container (e.g. state.inboxReader after a surface
  // switch) — the reader must NOT be returned, and must not shadow a lower
  // surface that IS really present.
  const exists = (sel) => sel !== '.reader';
  assert.equal(pickModal(SURFACES, { readerOpen: true }, exists), null);
  assert.equal(pickModal(SURFACES, { sheetOpen: true, readerOpen: true }, exists).close, 'closeSheet');
  // Higher-priority stale entry falls through to a live lower one.
  const onlyReaderLive = (sel) => sel === '.reader';
  assert.equal(pickModal(SURFACES, { sheetOpen: true, readerOpen: true }, onlyReaderLive).close, 'closeReader');
});

test('pickModal: omitting the exists predicate keeps pure state-flag behavior', () => {
  assert.equal(pickModal(SURFACES, { readerOpen: true }).close, 'closeReader');
});
