import { test } from 'node:test';
import assert from 'node:assert';
import { derivedDepth, closeTopmost, edgeSwipeBlocked, computeMobileLatch } from '../redesign/mobile/mobile-history.js';

test('depth 0 on a bare tab', () => {
  assert.equal(derivedDepth({ mTab: 'chat' }), 0);
});

test('each layer adds one: sub-screen, reader, sheet', () => {
  assert.equal(derivedDepth({ mTab: 'more', mSub: 'library' }), 1);
  assert.equal(derivedDepth({ mTab: 'email', mReader: true }), 1);
  assert.equal(derivedDepth({ mTab: 'chat', mModelSheetOpen: true }), 1);
  assert.equal(derivedDepth({ mTab: 'more', mSub: 'settings', quickCaptureOpen: true }), 2);
});

test('message long-press sheet (nested in live.chat) counts', () => {
  assert.equal(derivedDepth({ mTab: 'chat', live: { chat: { mobileSheetMsgId: 'm1' } } }), 1);
});

test('inbox reader counts as a layer', () => {
  assert.equal(derivedDepth({ mTab: 'inbox', inboxReader: { id: '1' } }), 1);
});

test('compose sheet counts as a layer', () => {
  assert.equal(derivedDepth({ mTab: 'email', composeOpen: true }), 1);
});

// Regression: capture and the conversation drawer used to be bucketed into a
// single "any sheet" layer, so both being open at once still only counted as
// depth 1 — meaning a single Back closed both together instead of one at a
// time. They're distinct priority levels now.
test('capture and drawer are two DISTINCT layers, not one bucket', () => {
  assert.equal(derivedDepth({ mTab: 'chat', mDrawerOpen: true, quickCaptureOpen: true }), 2);
});

// Regression: the drawer, model sheet, and companion sheet used to be
// bucketed into a single "drawer/model group" layer — protected only by the
// convention that at most one of the three was ever open at once, nothing in
// the code actually enforced that — so all three open together still only
// counted as depth 1, and one Back closed all three at once. They're three
// distinct priority levels now (model sheet → companion → drawer).
test('drawer, model sheet, and companion sheet are three DISTINCT layers, not one bucket', () => {
  assert.equal(derivedDepth({ mTab: 'chat', mDrawerOpen: true, mModelSheetOpen: true, companionSheetOpen: true }), 3);
});

test('closeTopmost within the old drawer/model bucket closes model sheet, then companion, then drawer — one at a time', () => {
  const s = { mTab: 'chat', mDrawerOpen: true, companionSheetOpen: true, mModelSheetOpen: true };
  assert.equal(derivedDepth(s), 3);

  assert.equal(closeTopmost(s), true);
  assert.equal(s.mModelSheetOpen, false, 'model sheet closes first');
  assert.equal(s.companionSheetOpen, true, 'companion survives');
  assert.equal(s.mDrawerOpen, true, 'drawer survives');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.companionSheetOpen, false, 'companion closes next');
  assert.equal(s.mDrawerOpen, true, 'drawer still survives');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.mDrawerOpen, false, 'drawer closes last');
  assert.equal(derivedDepth(s), 0);
});

test('closeTopmost closes msg-sheet, then capture, then compose, then reader, then model sheet, then companion, then drawer, then sub-screen — one at a time', () => {
  const s = {
    mTab: 'more',
    mSub: 'notes',
    mReader: true,
    mModelSheetOpen: true,
    companionSheetOpen: true,
    mDrawerOpen: true,
    composeOpen: true,
    quickCaptureOpen: true,
    live: { chat: { mobileSheetMsgId: 'm1' } },
  };
  assert.equal(derivedDepth(s), 8);

  assert.equal(closeTopmost(s), true);
  assert.equal(s.live.chat.mobileSheetMsgId, null, 'msg-sheet closes first');
  assert.equal(s.quickCaptureOpen, true, 'everything else survives');
  assert.equal(s.composeOpen, true);
  assert.equal(s.mReader, true);
  assert.equal(s.mModelSheetOpen, true);
  assert.equal(s.companionSheetOpen, true);
  assert.equal(s.mDrawerOpen, true);
  assert.equal(s.mSub, 'notes');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.quickCaptureOpen, false, 'capture closes next');
  assert.equal(s.composeOpen, true);

  assert.equal(closeTopmost(s), true);
  assert.equal(s.composeOpen, false, 'compose closes next');
  assert.equal(s.mReader, true, 'reader survives the compose close');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.mReader, false, 'reader closes next');
  assert.equal(s.mModelSheetOpen, true, 'model sheet survives the reader close');
  assert.equal(s.mSub, 'notes');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.mModelSheetOpen, false, 'model sheet closes next');
  assert.equal(s.companionSheetOpen, true, 'companion survives the model-sheet close');
  assert.equal(s.mDrawerOpen, true);

  assert.equal(closeTopmost(s), true);
  assert.equal(s.companionSheetOpen, false, 'companion closes next');
  assert.equal(s.mDrawerOpen, true, 'drawer survives the companion close');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.mDrawerOpen, false, 'drawer closes next');
  assert.equal(s.mSub, 'notes', 'sub-screen survives the drawer close');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.mSub, null, 'sub-screen closes last');

  assert.equal(closeTopmost(s), false, 'nothing left to close');
});

// Regression for the audit bug: one hardware Back used to clear every open
// sheet flag together (they were a single bucket). Each must close alone.
test('closeTopmost never clears more than one sheet flag per call', () => {
  const s = { mTab: 'chat', mDrawerOpen: true, quickCaptureOpen: true, composeOpen: true };
  assert.equal(derivedDepth(s), 3, 'capture, compose, and drawer are three distinct layers');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.quickCaptureOpen, false, 'capture closes first');
  assert.equal(s.composeOpen, true, 'compose survives the same call');
  assert.equal(s.mDrawerOpen, true, 'drawer survives the same call');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.composeOpen, false, 'compose closes next');
  assert.equal(s.mDrawerOpen, true, 'drawer still survives');

  assert.equal(closeTopmost(s), true);
  assert.equal(s.mDrawerOpen, false, 'drawer closes last');
  assert.equal(derivedDepth(s), 0);
});

test('closeTopmost is a no-op on a bare tab', () => {
  const s = { mTab: 'chat' };
  assert.equal(closeTopmost(s), false);
});

// ---- edgeSwipeBlocked -----------------------------------------------------

test('edgeSwipeBlocked is false with no overlay open', () => {
  assert.equal(edgeSwipeBlocked({ mTab: 'chat' }), false);
});

test('edgeSwipeBlocked blocks over the compose sheet', () => {
  assert.equal(edgeSwipeBlocked({ composeOpen: true }), true);
});

test('edgeSwipeBlocked blocks over the inbox reader', () => {
  assert.equal(edgeSwipeBlocked({ inboxReader: { id: '1' } }), true);
});

test('edgeSwipeBlocked blocks over the email reader (mReader)', () => {
  assert.equal(edgeSwipeBlocked({ mReader: true }), true);
});

test('edgeSwipeBlocked blocks over the message-tools long-press sheet', () => {
  assert.equal(edgeSwipeBlocked({ live: { chat: { mobileSheetMsgId: 'm1' } } }), true);
});

test('edgeSwipeBlocked blocks over capture, companion, model sheet, and the drawer itself', () => {
  assert.equal(edgeSwipeBlocked({ quickCaptureOpen: true }), true);
  assert.equal(edgeSwipeBlocked({ companionSheetOpen: true }), true);
  assert.equal(edgeSwipeBlocked({ mModelSheetOpen: true }), true);
  assert.equal(edgeSwipeBlocked({ mDrawerOpen: true }), true);
});

test('edgeSwipeBlocked blocks while the keyboard is up', () => {
  assert.equal(edgeSwipeBlocked({ keyboard: true }), true);
});

// ---- computeMobileLatch ----------------------------------------------------

test('computeMobileLatch: touch + coarse pointer is mobile through a phone landscape rotation', () => {
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: true, width: 926 }), true);
});

test('computeMobileLatch: touch + coarse pointer stays mobile at a narrow width too', () => {
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: true, width: 390 }), true);
});

test('computeMobileLatch: a narrow desktop window (no touch) still latches mobile at boot', () => {
  assert.equal(computeMobileLatch({ coarsePointer: false, touchCapable: false, width: 700 }), true);
});

test('computeMobileLatch: a wide desktop window with no touch stays desktop', () => {
  assert.equal(computeMobileLatch({ coarsePointer: false, touchCapable: false, width: 1440 }), false);
});

test('computeMobileLatch: coarse pointer alone (no touch events) is not enough', () => {
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: false, width: 1440 }), false);
});

test('computeMobileLatch: touch alone (no coarse pointer) is not enough', () => {
  assert.equal(computeMobileLatch({ coarsePointer: false, touchCapable: true, width: 1440 }), false);
});

// Regression: coarse+touch used to latch mobile at ANY width, with no upper
// bound — an iPad in landscape (genuinely coarse+touch, ~1180px wide) would
// get the phone UI for the rest of the session. touchCeiling (default 1024)
// bounds the coarse+touch signal; the plain narrow-width clause is untouched.
test('computeMobileLatch: coarse+touch beyond the tablet ceiling (iPad landscape) does NOT latch mobile', () => {
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: true, width: 1180 }), false);
});

test('computeMobileLatch: coarse+touch exactly at the 1024 ceiling still latches mobile', () => {
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: true, width: 1024 }), true);
});

test('computeMobileLatch: coarse+touch one pixel past the ceiling does not latch mobile', () => {
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: true, width: 1025 }), false);
});

test('computeMobileLatch: the ceiling is configurable via touchCeiling', () => {
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: true, width: 900, touchCeiling: 800 }), false);
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: true, width: 900, touchCeiling: 1200 }), true);
});

// A coarse+touch iPad in a narrow Split View (below the PLAIN breakpoint,
// not just below the touch ceiling) still latches mobile — the ceiling only
// removes the touch signal's unconditional (any-width) latch above 1024, it
// doesn't turn off the ordinary <=768 breakpoint clause.
test('computeMobileLatch: coarse+touch narrower than the plain breakpoint still latches (e.g. iPad Split View)', () => {
  assert.equal(computeMobileLatch({ coarsePointer: true, touchCapable: true, width: 700, touchCeiling: 1024 }), true);
});
