import { test } from 'node:test';
import assert from 'node:assert';
import { mChatMsg } from '../redesign/mobile/mobile-surfaces.js';

const state = { live: { chat: { mobileSheetMsgId: null, msgMenuOpen: null } } };

test('mobile assistant error turn renders a visible error notice', () => {
  const html = mChatMsg({ id: 'a1', role: 'assistant', text: '', error: true, notice: 'Model unavailable on this plan.' }, state);
  assert.match(html, /m-msg-error/);
  assert.match(html, /Model unavailable on this plan\./);
});

test('mobile assistant error falls back to default copy without a custom notice', () => {
  const html = mChatMsg({ id: 'a2', role: 'assistant', text: '', error: true }, state);
  assert.match(html, /No response from this model\./);
});

test('mobile assistant success turn renders no error notice', () => {
  const html = mChatMsg({ id: 'a3', role: 'assistant', text: 'hello world' }, state);
  assert.doesNotMatch(html, /m-msg-error/);
});
