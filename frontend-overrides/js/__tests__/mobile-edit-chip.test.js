import { test } from 'node:test';
import assert from 'node:assert';
import { mChatMsg } from '../redesign/mobile/mobile-surfaces.js';

const s = { live: { chat: { mobileSheetMsgId: null, msgMenuOpen: null } } };

test('non-optimistic user bubble renders no pending-ring or edit chip', () => {
  const html = mChatMsg({ id: 'u1', role: 'user', text: 'hi', time: '10:00' }, s);
  assert.doesNotMatch(html, /m-msg-pending-ring/);
  assert.doesNotMatch(html, /m-msg-edit-chip/);
});

test('optimistic user bubble renders pending-ring and edit chip', () => {
  const html = mChatMsg({
    id: 'u2', role: 'user', text: 'hey', time: '10:00',
    _optimistic: true, _deadline: Date.now() + 700,
  }, s);
  assert.match(html, /class="m-msg-pending-ring"/);
  assert.match(html, /class="m-msg-edit-chip"[^>]*data-act="editPendingOnMobile"[^>]*data-arg="u2"/);
  assert.match(html, />Tap to edit</);
});

test('optimistic message with no deadline does not render ring/chip', () => {
  const html = mChatMsg({
    id: 'u3', role: 'user', text: 'x', time: '10:00', _optimistic: true,
  }, s);
  assert.doesNotMatch(html, /m-msg-pending-ring/);
  assert.doesNotMatch(html, /m-msg-edit-chip/);
});

test('assistant bubble never renders edit chip', () => {
  const html = mChatMsg({
    id: 'a1', role: 'assistant', text: 'hi', time: '10:00',
    _optimistic: true, _deadline: Date.now() + 700,
  }, s);
  assert.doesNotMatch(html, /m-msg-edit-chip/);
});
