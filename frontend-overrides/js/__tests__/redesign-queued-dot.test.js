import { test } from 'node:test';
import assert from 'node:assert';
import { renderChatList } from '../redesign/surfaces.js';

// M6 (deferred from the chat.js follow-up bundle to the wave-5 surfaces
// sweep): a message queued in a session you've since switched away from
// (chat.js's session-keyed chat.queuedList) used to be invisible in the
// conversation list until you happened to reopen that thread. A small dot on
// its row — read-only off state.live.chat.queuedList, never written here —
// says "something's waiting here".
const baseState = (over = {}) => ({
  convFilter: '', convSort: 'recent',
  live: { chat: {
    cwd: '/x', rowMenuOpen: null,
    groups: [{ label: 'TODAY', rows: [
      { id: 's1', title: 'Active chat', active: true },
      { id: 's2', title: 'Other chat', active: false },
      { id: 's3', title: 'Third chat', active: false },
    ] }],
    queuedList: [],
    ...over,
  } },
});

test('a non-active session with a queued message gets the queued dot', () => {
  const html = renderChatList(baseState({ queuedList: [{ sid: 's2', text: 'hi' }] }));
  const rowS2 = html.slice(html.indexOf('data-arg="s2"'), html.indexOf('data-arg="s3"'));
  assert.match(rowS2, /class="conv-dot queued"/);
});

test('the ACTIVE session never gets the queued dot even if it has a queued entry', () => {
  // (queueHead already surfaces the active session's own queued message as
  // the "Queued — sends when the reply finishes" banner in the composer —
  // see s.live.chat.queued in chatSurface — so the row dot is reserved for
  // OTHER sessions only, or the same information would render twice.)
  const html = renderChatList(baseState({ queuedList: [{ sid: 's1', text: 'hi' }] }));
  const rowS1 = html.slice(html.indexOf('data-arg="s1"'), html.indexOf('data-arg="s2"'));
  assert.doesNotMatch(rowS1, /conv-dot queued/);
});

test('a session with nothing queued has no dot', () => {
  const html = renderChatList(baseState({ queuedList: [{ sid: 's2', text: 'hi' }] }));
  const rowS3 = html.slice(html.indexOf('data-arg="s3"'));
  assert.doesNotMatch(rowS3, /conv-dot queued/);
});

test('working/notify indicators still take precedence over the queued dot on the same row', () => {
  const html = renderChatList(baseState({
    queuedList: [{ sid: 's2', text: 'hi' }],
    groups: [{ label: 'TODAY', rows: [
      { id: 's1', title: 'Active chat', active: true },
      { id: 's2', title: 'Other chat', active: false, working: true },
    ] }],
  }));
  const rowS2 = html.slice(html.indexOf('data-arg="s2"'));
  assert.match(rowS2, /conv-spin working/);
  assert.doesNotMatch(rowS2, /conv-dot queued/);
});
