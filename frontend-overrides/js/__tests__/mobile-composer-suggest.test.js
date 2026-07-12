import { test } from 'node:test';
import assert from 'node:assert';
import { mChat } from '../redesign/mobile/mobile-surfaces.js';

const baseState = () => ({
  draft: '', pendingAttach: [], keyboard: false, refreshing: false, dismissed: [],
  mobileEditingPending: null,
  live: { chat: {
    thread: [],
    mobileSheetMsgId: null, msgMenuOpen: null,
    title: 't', endpointId: 'x', model: 'y',
  }, modelList: [] },
});

test('no ghost without a suggestion', () => {
  assert.doesNotMatch(mChat(baseState()), /ghost-suggest/);
});

test('ghost renders tappable when suggestion set and draft empty', () => {
  const s = baseState();
  s.live.chat.suggest = { text: 'While you wait, fix the cron job', mode: 'midturn' };
  const html = mChat(s);
  assert.match(html, /ghost-suggest m-ghost/);
  assert.match(html, /data-act="acceptSuggest"/);
  assert.match(html, /While you wait, fix the cron job/);
  // placeholder suppressed to a single space while the ghost shows
  assert.match(html, /data-focus="mdraft"[^>]*placeholder=" "/);
});

test('ghost suppressed while draft has text', () => {
  const s = baseState();
  s.live.chat.suggest = { text: 'While you wait, fix the cron job', mode: 'midturn' };
  s.draft = 'typing';
  assert.doesNotMatch(mChat(s), /ghost-suggest/);
});
