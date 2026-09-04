import { test } from 'node:test';
import assert from 'node:assert';
import { shouldSwipeDismiss, applyCloseSheet } from '../redesign/mobile/sheet-close.js';

test('shouldSwipeDismiss true when downward drag exceeds 60px within 400ms', () => {
  assert.strictEqual(shouldSwipeDismiss({ dy: 65, dtMs: 200 }), true);
});

test('shouldSwipeDismiss false when drag under 60px', () => {
  assert.strictEqual(shouldSwipeDismiss({ dy: 40, dtMs: 200 }), false);
});

test('shouldSwipeDismiss false when drag over 400ms', () => {
  assert.strictEqual(shouldSwipeDismiss({ dy: 100, dtMs: 500 }), false);
});

test('shouldSwipeDismiss false on upward drag', () => {
  assert.strictEqual(shouldSwipeDismiss({ dy: -80, dtMs: 200 }), false);
});

test('applyCloseSheet clears mobileSheetMsgId when flag is truthy', () => {
  const s = { live: { chat: { mobileSheetMsgId: 'u1' } } };
  applyCloseSheet(s, '1');
  assert.strictEqual(s.live.chat.mobileSheetMsgId, null);
});

test('applyCloseSheet leaves state untouched when flag is null', () => {
  const s = { live: { chat: { mobileSheetMsgId: 'u1' } } };
  applyCloseSheet(s, null);
  assert.strictEqual(s.live.chat.mobileSheetMsgId, 'u1');
});

test('applyCloseSheet is a no-op when chat state is missing', () => {
  const s = {};
  applyCloseSheet(s, '1');
  assert.deepStrictEqual(s, {});
});

test('applyCloseSheet closes only the sheet the flag names', () => {
  const s = () => ({ live: { chat: { mobileSheetMsgId: 'u1', mobileConvSheetId: 's1' } } });
  const a = s();
  applyCloseSheet(a, 'conv');
  assert.strictEqual(a.live.chat.mobileConvSheetId, null);
  assert.strictEqual(a.live.chat.mobileSheetMsgId, 'u1', 'the message sheet is untouched');
  const b = s();
  applyCloseSheet(b, 'msg');
  assert.strictEqual(b.live.chat.mobileSheetMsgId, null);
  assert.strictEqual(b.live.chat.mobileConvSheetId, 's1', 'the conv sheet is untouched');
  // The legacy "1" the message sheet has always emitted still means the
  // message sheet.
  const c = s();
  applyCloseSheet(c, '1');
  assert.strictEqual(c.live.chat.mobileSheetMsgId, null);
  assert.strictEqual(c.live.chat.mobileConvSheetId, 's1');
});
