import { test } from 'node:test';
import assert from 'node:assert';
import { mChat } from '../redesign/mobile/mobile-surfaces.js';

const baseState = () => ({
  draft: '', pendingAttach: [], keyboard: false, refreshing: false, dismissed: [],
  mobileEditingPending: null,
  live: { chat: {
    thread: [],
    activeId: 's1',
    mobileSheetMsgId: null, msgMenuOpen: null,
    title: 't', endpointId: 'x', model: 'y',
  }, modelList: [] },
});

const SUG = { text: 'While you wait, fix the cron job', mode: 'midturn', sessionId: 's1' };

test('no ghost without a suggestion', () => {
  assert.doesNotMatch(mChat(baseState()), /ghost-suggest/);
});

test('ghost renders tappable when suggestion set and draft empty', () => {
  const s = baseState();
  s.live.chat.suggest = { ...SUG };
  const html = mChat(s);
  assert.match(html, /ghost-suggest m-ghost/);
  assert.match(html, /data-act="acceptSuggest"/);
  assert.match(html, /While you wait, fix the cron job/);
  // the REAL placeholder stays (masked via CSS) — :placeholder-shown must
  // keep driving the send-button disable while the composer is empty
  assert.match(html, /data-focus="mdraft"[^>]*placeholder="Message /);
});

test('ghost suppressed while draft has text', () => {
  const s = baseState();
  s.live.chat.suggest = { ...SUG };
  s.draft = 'typing';
  assert.doesNotMatch(mChat(s), /ghost-suggest/);
});

test('ghost from another session never renders (archived/switched thread)', () => {
  const s = baseState();
  s.live.chat.suggest = { ...SUG, sessionId: 'other-session' };
  assert.doesNotMatch(mChat(s), /ghost-suggest/);
});
