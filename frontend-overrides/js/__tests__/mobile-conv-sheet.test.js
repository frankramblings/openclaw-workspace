// Pure render of the mobile thread-actions sheet (the "⋯" button / long-press
// on a Conversations-drawer row). Same action names as the desktop conv menu.
import { test } from 'node:test';
import assert from 'node:assert';
import { convActionSheet } from '../redesign/mobile/mobile-conv-sheet.js';

const state = (over = {}, rowOver = {}) => ({
  live: {
    projects: [
      { id: 'p1', name: 'Beta' },
      { id: 'p2', name: 'Alpha' },
      { id: 'p3', name: 'Gone', archived: true },
    ],
    chat: {
      mobileConvSheetId: 's1',
      groups: [{ label: 'TODAY', rows: [
        { id: 's1', title: 'Plain chat', important: false, folder: null, ...rowOver },
        { id: 's2', title: 'Other' },
      ] }],
      ...over,
    },
  },
});

test('renders nothing until a row id is set', () => {
  assert.equal(convActionSheet(state({ mobileConvSheetId: null })), '');
  assert.equal(convActionSheet(state({ mobileConvSheetId: 'nope' })), '', 'unknown id renders nothing');
});

test('rows dispatch the desktop actions with the row id and close the sheet', () => {
  const html = convActionSheet(state());
  for (const act of ['renameSession', 'toggleFavorite', 'toggleUnread', 'copyTranscript', 'archiveSession', 'deleteSession']) {
    assert.match(html, new RegExp(`data-act="${act}" data-arg="s1"`), act);
  }
  assert.match(html, /data-act="closeConvActions"/, 'cancel row closes the sheet');
  assert.match(html, /m-conv-sheet-row m-conv-sheet-danger" data-act="deleteSession"/);
  // Every action row carries the close flag so a tap dismisses the sheet.
  const rows = html.match(/class="m-conv-sheet-row[^"]*"[^>]*data-act="[^"]+"/g) || [];
  assert.ok(rows.length >= 7);
  assert.equal((html.match(/data-close-sheet="conv"/g) || []).length, rows.length - 1, 'all but Cancel close THIS sheet by name');
  assert.doesNotMatch(html, /data-close-sheet="1"/, 'never the message sheet\'s flag');
});

test('favorite and unread labels flip with the row state', () => {
  assert.match(convActionSheet(state()), /Favorite<\/span>/);
  assert.match(convActionSheet(state()), /Mark unread<\/span>/);
  const flipped = convActionSheet(state({}, { important: true, unread: true }));
  assert.match(flipped, /Unfavorite<\/span>/);
  assert.match(flipped, /Mark read<\/span>/);
});

test('the move rows sit under a Move to head, and the head is dropped with no rows', () => {
  const html = convActionSheet(state());
  const headIdx = html.indexOf('m-conv-sheet-head');
  assert.ok(headIdx > -1, 'section head rendered');
  assert.ok(headIdx < html.indexOf('data-act="moveToProject"'), 'head precedes the rows');
  const bare = convActionSheet({ live: { projects: [], chat: {
    mobileConvSheetId: 's1',
    groups: [{ rows: [{ id: 's1', title: 'Plain chat', folder: null }] }],
  } } });
  assert.doesNotMatch(bare, /m-conv-sheet-head/, 'no head when there is nowhere to move to');
  assert.doesNotMatch(bare, /moveToProject/);
});

test('a row lit by the finished-while-away flag also reads Mark read', () => {
  // `notify` is what rowOf hands the renderer once EITHER source lit the dot.
  assert.match(convActionSheet(state({}, { notify: true })), /Mark read<\/span>/);
  assert.match(convActionSheet(state()), /Mark unread<\/span>/);
});

test('one move row per non-archived project, alphabetical, archived hidden', () => {
  const html = convActionSheet(state());
  const labels = [...html.matchAll(/data-act="moveToProject" data-arg="s1\|([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['p2', 'p1'], 'Alpha before Beta, Gone omitted');
  assert.doesNotMatch(html, /Gone/);
});

test('Remove from project shows only when the thread is filed, and marks the current project', () => {
  assert.doesNotMatch(convActionSheet(state()), /Remove from project/);
  const filed = convActionSheet(state({}, { folder: 'p1' }));
  assert.match(filed, /Remove from project/);
  assert.match(filed, /data-act="moveToProject" data-arg="s1\|"/, 'removal targets the empty project');
  assert.match(filed, /m-conv-sheet-row on" data-act="moveToProject" data-arg="s1\|p1"/, 'current project marked');
});

test('the sheet copy carries no em dashes', () => {
  assert.doesNotMatch(convActionSheet(state({}, { folder: 'p1' })), /—/);
});
