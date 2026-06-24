import { test } from 'node:test';
import assert from 'node:assert';
import { renderChatList } from '../redesign/surfaces.js';

const baseState = (over = {}) => ({
  convFilter: '', convSort: 'recent',
  live: { chat: {
    cwd: '/x', rowMenuOpen: null,
    groups: [{ label: 'TODAY', rows: [
      { id: 's1', title: 'Plain chat', active: true, important: false },
      { id: 's2', title: 'Pinned chat', important: true },
    ] }],
    ...over,
  } },
});

test('each row renders a kebab that toggles its menu', () => {
  const html = renderChatList(baseState());
  assert.match(html, /class="conv-kebab"[^>]*data-act="toggleConvMenu" data-arg="s1"/);
  assert.match(html, /data-act="toggleConvMenu" data-arg="s2"/);
});

test('a favorited row shows the gold star, an unfavorited row does not', () => {
  const html = renderChatList(baseState());
  // s2 (important) has the star wrapper; s1 does not.
  assert.match(html, /class="conv-fav"/);
  assert.equal((html.match(/class="conv-fav"/g) || []).length, 1);
});

test('no menu renders until rowMenuOpen matches a row', () => {
  assert.doesNotMatch(renderChatList(baseState()), /class="conv-menu"/);
});

test('open menu renders all five items with the row id', () => {
  const html = renderChatList(baseState({ rowMenuOpen: 's1' }));
  assert.match(html, /class="conv-menu" data-act="noop"/);
  assert.match(html, /data-act="renameSession" data-arg="s1"/);
  assert.match(html, /data-act="toggleFavorite" data-arg="s1"/);
  assert.match(html, /data-act="copyTranscript" data-arg="s1"/);
  assert.match(html, /data-act="archiveSession" data-arg="s1"/);
  assert.match(html, /cm-danger" data-act="deleteSession" data-arg="s1"/);
});

test('favorite label reflects the row state', () => {
  assert.match(renderChatList(baseState({ rowMenuOpen: 's1' })), /data-act="toggleFavorite"[^>]*>Favorite</);
  assert.match(renderChatList(baseState({ rowMenuOpen: 's2' })), /data-act="toggleFavorite"[^>]*>Unfavorite</);
});
