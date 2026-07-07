import { test } from 'node:test';
import assert from 'node:assert';
import { assistantToolbar, userSheet, mdMenu } from '../redesign/mobile/mobile-msg-tools.js';

const asst = { id: 'a1', role: 'assistant', text: 'hello', time: '10:00' };
const usr = { id: 'u1', role: 'user', text: 'hi there', time: '10:00' };
const stateClosed = { live: { chat: { mobileSheetMsgId: null, msgMenuOpen: null } } };
const stateOpen = { live: { chat: { mobileSheetMsgId: 'u1', msgMenuOpen: null } } };

test('assistantToolbar renders three action buttons', () => {
  const html = assistantToolbar(asst, stateClosed);
  assert.match(html, /data-act="copyMessage"[^>]*data-arg="a1"/);
  assert.match(html, /data-act="branchFromMessage"[^>]*data-arg="a1"/);
  assert.match(html, /data-act="toggleMsgMenu"[^>]*data-arg="a1"/);
});

test('assistantToolbar hides during streaming', () => {
  const html = assistantToolbar({ ...asst, streaming: true }, stateClosed);
  assert.strictEqual(html, '');
});

test('assistantToolbar hides on error', () => {
  const html = assistantToolbar({ ...asst, error: true }, stateClosed);
  assert.strictEqual(html, '');
});

test('assistantToolbar hides when text empty', () => {
  const html = assistantToolbar({ ...asst, text: '' }, stateClosed);
  assert.strictEqual(html, '');
});

test('userSheet is empty when no sheet open', () => {
  assert.strictEqual(userSheet(usr, stateClosed), '');
});

test('userSheet is empty when a different message sheet is open', () => {
  const s = { live: { chat: { mobileSheetMsgId: 'u2', msgMenuOpen: null } } };
  assert.strictEqual(userSheet(usr, s), '');
});

test('userSheet renders preview + four action rows + cancel when open', () => {
  const html = userSheet(usr, stateOpen);
  assert.match(html, /m-msg-sheet-backdrop/);
  assert.match(html, /m-msg-sheet-preview[^>]*>[^<]*hi there/);
  assert.match(html, /data-act="copyMessage"[^>]*data-arg="u1"[^>]*data-close-sheet="1"/);
  assert.match(html, /data-act="branchFromMessage"[^>]*data-arg="u1"[^>]*data-close-sheet="1"/);
  assert.match(html, /data-act="downloadMessage"[^>]*data-arg="u1"[^>]*data-close-sheet="1"/);
  assert.match(html, /data-act="downloadMessagePDF"[^>]*data-arg="u1"[^>]*data-close-sheet="1"/);
  assert.match(html, /data-act="closeMobileMsgSheet"/);
});

test('userSheet preview escapes HTML', () => {
  const html = userSheet({ ...usr, text: '<script>x</script>' }, stateOpen);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('mdMenu is empty when closed', () => {
  assert.strictEqual(mdMenu(asst, false), '');
});

test('mdMenu renders Markdown + PDF rows when open', () => {
  const html = mdMenu(asst, true);
  assert.match(html, /data-act="downloadMessage"[^>]*data-arg="a1"/);
  assert.match(html, /data-act="downloadMessagePDF"[^>]*data-arg="a1"/);
});

import { mChatMsg, mChat } from '../redesign/mobile/mobile-surfaces.js';

test('mChatMsg for assistant includes the toolbar', () => {
  const s = { live: { chat: { mobileSheetMsgId: null, msgMenuOpen: null } } };
  const html = mChatMsg({ id: 'a2', role: 'assistant', text: 'hi', time: '10:00' }, s);
  assert.match(html, /m-msg-toolbar/);
  assert.match(html, /data-act="copyMessage"[^>]*data-arg="a2"/);
});

test('mChatMsg for user does NOT include a persistent toolbar', () => {
  const s = { live: { chat: { mobileSheetMsgId: null, msgMenuOpen: null } } };
  const html = mChatMsg({ id: 'u5', role: 'user', text: 'hi', time: '10:00' }, s);
  assert.doesNotMatch(html, /m-msg-toolbar/);
});

test('mChat appends sheet when mobileSheetMsgId matches a thread message', () => {
  const s = {
    draft: '', pendingAttach: [], keyboard: false, refreshing: false, dismissed: [],
    live: { chat: {
      thread: [{ id: 'u9', role: 'user', text: 'target', time: '10:00' }],
      mobileSheetMsgId: 'u9',
      msgMenuOpen: null,
      title: 'test', endpointId: 'x', model: 'y',
    }, modelList: [] },
  };
  const html = mChat(s);
  assert.match(html, /m-msg-sheet-backdrop/);
  assert.match(html, /m-msg-sheet-preview[^>]*>[^<]*target/);
});

test('mChat does NOT append sheet when mobileSheetMsgId is null', () => {
  const s = {
    draft: '', pendingAttach: [], keyboard: false, refreshing: false, dismissed: [],
    live: { chat: {
      thread: [{ id: 'u9', role: 'user', text: 'target', time: '10:00' }],
      mobileSheetMsgId: null,
      msgMenuOpen: null,
      title: 'test', endpointId: 'x', model: 'y',
    }, modelList: [] },
  };
  const html = mChat(s);
  assert.doesNotMatch(html, /m-msg-sheet-backdrop/);
});
