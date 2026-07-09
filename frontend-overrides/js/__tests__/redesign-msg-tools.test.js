import { test } from 'node:test';
import assert from 'node:assert';
import { chatMsg } from '../redesign/surfaces.js';

const ui = { chatUI: { trail: {}, step: {}, group: {} } };

test('user message gets a copy + download toolbar bound to its id', () => {
  const html = chatMsg({ id: 'u1', role: 'user', text: 'hi there', time: '09:00' }, ui);
  assert.match(html, /class="msg-tools"/);
  assert.match(html, /data-act="copyMessage" data-arg="u1"/);
  // Download is a disclosure toggle (msg-dl-wrap flyout); the actual
  // downloadMessage action only renders once its menu is open.
  assert.match(html, /data-act="toggleMsgMenu" data-arg="u1"/);

  const openUi = { ...ui, live: { chat: { msgMenuOpen: 'u1' } } };
  const openHtml = chatMsg({ id: 'u1', role: 'user', text: 'hi there', time: '09:00' }, openUi);
  assert.match(openHtml, /data-act="downloadMessage" data-arg="u1"/);
});

test('assistant message with text gets the toolbar', () => {
  const html = chatMsg({ id: 'a1', role: 'assistant', text: 'sure', time: '09:01', model: 'opus' }, ui);
  assert.match(html, /data-act="copyMessage" data-arg="a1"/);
  assert.match(html, /data-act="toggleMsgMenu" data-arg="a1"/);

  const openUi = { ...ui, live: { chat: { msgMenuOpen: 'a1' } } };
  const openHtml = chatMsg({ id: 'a1', role: 'assistant', text: 'sure', time: '09:01', model: 'opus' }, openUi);
  assert.match(openHtml, /data-act="downloadMessage" data-arg="a1"/);
});

test('empty / error assistant turn renders no toolbar', () => {
  const html = chatMsg({ id: 'a2', role: 'assistant', text: '', error: true, notice: 'No response from this model.' }, ui);
  assert.doesNotMatch(html, /class="msg-tools"/);
});
