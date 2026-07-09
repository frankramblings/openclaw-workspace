import { test } from 'node:test';
import assert from 'node:assert';
import { chatMsg } from '../redesign/surfaces.js';

const base = { live: { chat: { messages: [
  { id: 'u1', role: 'user', text: 'hi', time: '10:00' },
  { id: 'a1', role: 'assistant', text: 'hello', time: '10:00' },
  { id: 'u2', role: 'user', text: 'next', time: '10:01' },
], pendingSend: null } } };

test('any message has branch button', () => {
  assert.match(chatMsg(base.live.chat.messages[0], base), /data-act="branchFromMessage"/);
  assert.match(chatMsg(base.live.chat.messages[1], base), /data-act="branchFromMessage"/);
  assert.match(chatMsg(base.live.chat.messages[2], base), /data-act="branchFromMessage"/);
});

test('no message has edit when nothing is pending', () => {
  assert.doesNotMatch(chatMsg(base.live.chat.messages[2], base), /data-act="editMessage"/);
});

test('pending-send bubble has edit', () => {
  const s = { live: { chat: { ...base.live.chat,
    messages: [...base.live.chat.messages, { id: 'p1', role: 'user', text: 'draft', time: '10:02' }],
    pendingSend: { messageId: 'p1' } } } };
  assert.match(
    chatMsg({ id: 'p1', role: 'user', text: 'draft', time: '10:02' }, s),
    /data-act="editMessage"/
  );
});
