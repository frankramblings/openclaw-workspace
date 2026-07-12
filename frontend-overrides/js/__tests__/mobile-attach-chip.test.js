// Rider (task-w6): the pending-attachment chip's ✕ (removeAttach) was a bare
// <span> — no keyboard focus, no screen-reader semantics, unlike every other
// dismiss glyph in this file (.m-toast-x, .m-q-x, .m-email-summary .hd .x),
// which are already real <button>s. It also inherited a stale ≥44pt ::after
// inset (-14px) that overshot .m-attach-row's tight 6-7px gaps and could
// paint over an ADJACENT chip's own remove button — the exact bug
// .m-toast-x::after's comment already documents and fixes for the toast.
import { test } from 'node:test';
import assert from 'node:assert';
import { mChat } from '../redesign/mobile/mobile-surfaces.js';

const baseState = (pendingAttach) => ({
  draft: '', pendingAttach, keyboard: false, refreshing: false, dismissed: [],
  mobileEditingPending: null,
  live: { chat: {
    thread: [],
    mobileSheetMsgId: null, msgMenuOpen: null,
    title: 't', endpointId: 'x', model: 'y',
  }, modelList: [] },
});

test('attach chip remove control is a real <button>, not a bare <span>', () => {
  const html = mChat(baseState([{ id: 'a1', name: 'photo.png' }]));
  assert.match(html, /<button type="button" class="x" data-act="removeAttach" data-arg="a1" aria-label="Remove attachment">✕<\/button>/);
  assert.doesNotMatch(html, /<span class="x" data-act="removeAttach"/);
});

test('attach chip remove button has an accessible label', () => {
  const html = mChat(baseState([{ id: 'a1', name: 'photo.png' }]));
  assert.match(html, /aria-label="Remove attachment"/);
});

test('no attachments → no attach row at all', () => {
  const html = mChat(baseState([]));
  assert.doesNotMatch(html, /m-attach-row/);
});

test('multiple attachments each get their own independently-addressable remove button', () => {
  const html = mChat(baseState([{ id: 'a1', name: 'one.png' }, { id: 'a2', name: 'two.png' }]));
  assert.match(html, /data-arg="a1"/);
  assert.match(html, /data-arg="a2"/);
});
