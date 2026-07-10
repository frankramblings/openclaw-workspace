import { test } from 'node:test';
import assert from 'node:assert';
import { derivedDepth, closeTopmost } from '../redesign/mobile/mobile-history.js';

test('depth 0 on a bare tab', () => {
  assert.equal(derivedDepth({ mTab: 'chat' }), 0);
});

test('each layer adds one: sub-screen, reader, sheet', () => {
  assert.equal(derivedDepth({ mTab: 'more', mSub: 'library' }), 1);
  assert.equal(derivedDepth({ mTab: 'email', mReader: true }), 1);
  assert.equal(derivedDepth({ mTab: 'chat', mModelSheetOpen: true }), 1);
  assert.equal(derivedDepth({ mTab: 'more', mSub: 'settings', quickCaptureOpen: true }), 2);
});

test('any open sheet counts as one layer, not one each', () => {
  assert.equal(derivedDepth({ mTab: 'chat', mDrawerOpen: true, quickCaptureOpen: true }), 1);
});

test('message long-press sheet (nested in live.chat) counts', () => {
  assert.equal(derivedDepth({ mTab: 'chat', live: { chat: { mobileSheetMsgId: 'm1' } } }), 1);
});

test('inbox reader counts as a layer', () => {
  assert.equal(derivedDepth({ mTab: 'inbox', inboxReader: { id: '1' } }), 1);
});

test('closeTopmost closes sheets before readers before sub-screens', () => {
  const s = { mTab: 'more', mSub: 'notes', mReader: true, mModelSheetOpen: true, live: { chat: { mobileSheetMsgId: 'm1' } } };
  assert.equal(closeTopmost(s), true);
  assert.equal(s.mModelSheetOpen, false);
  assert.equal(s.live.chat.mobileSheetMsgId, null);
  assert.equal(s.mReader, true, 'reader survives the sheet close');
  assert.equal(closeTopmost(s), true);
  assert.equal(s.mReader, false);
  assert.equal(s.mSub, 'notes', 'sub-screen survives the reader close');
  assert.equal(closeTopmost(s), true);
  assert.equal(s.mSub, null);
  assert.equal(closeTopmost(s), false, 'nothing left to close');
});

test('closeTopmost clears every sheet flag in one step', () => {
  const s = { mTab: 'chat', mDrawerOpen: true, quickCaptureOpen: true, composeOpen: true };
  closeTopmost(s);
  assert.equal(s.mDrawerOpen, false);
  assert.equal(s.quickCaptureOpen, false);
  assert.equal(s.composeOpen, false);
  assert.equal(derivedDepth(s), 0);
});
