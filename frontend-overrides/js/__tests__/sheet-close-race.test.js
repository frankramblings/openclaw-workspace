// Regression coverage for a race found in review of the mobile sheet
// exit-animation work (task 5, motion-interaction-fix): closeSheetAnimated
// (mobile-app.js) and the inline copies in email.js's closeCompose and
// inbox.js's closeSnooze scheduled an UNCONDITIONAL setTimeout that force-set
// openFlag/closingFlag false 200ms later, with no check that the close it was
// finishing was still the one in effect. Reopening a sheet (or a DIFFERENT
// item sharing the same flag, e.g. inboxSnoozeFor) inside that 200ms window
// got silently force-closed when the stale timer fired — reachable via the
// ordinary inbox-triage ⏰ workflow and email reply/compose flow, not an
// edge case. Fixed by: every "open" path clears the *Closing flag, and each
// setTimeout checks `if (!state[closingFlag]) return;` before applying its
// close — a reopen invalidates the pending close instead of the timer
// clobbering state that has moved on. As a side effect this also collapses a
// rapid multi-tap close on the SAME sheet down to one real effect instead of
// N independent timers all firing.
//
// Also covers the "confirmed false" desktop claim: closeCompose/closeSnooze
// are shared with desktop surfaces (surfaces.js .oc-compose / snoozeMenu),
// neither of which reads the *Closing flag, so those now skip the animated
// path entirely and close instantly — no 200ms visible-delay glitch.
import { test, mock } from 'node:test';
import assert from 'node:assert';

// live/email.js and live/inbox.js both import api.js, which reads
// `location.origin` at module-eval time (same pattern as
// email-open-honest.test.js / redesign-model-picker.test.js).
globalThis.location = { origin: 'http://localhost' };

// isMobileShell() (email.js/inbox.js) reads document.documentElement's
// classList — same pattern as document-editor.test.js's shim. Mutable so
// individual tests can flip between the mobile-shell and desktop-shell case.
let mobileShell = true;
globalThis.document = { documentElement: { classList: { contains: () => mobileShell } } };

const { runtime } = await import('../redesign/live/runtime.js');
const { mobileActions } = await import('../redesign/mobile/mobile-app.js');
const { actions: emailActions } = await import('../redesign/live/email.js');
const { actions: inboxActions } = await import('../redesign/live/inbox.js');

// ---- mobile-app.js: companion/capture/model sheets ---------------------------

test('reopening a sheet mid-close cancels the pending force-close (mobile-app.js)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = { companionSheetOpen: true, companionSheetClosing: false };
    const actions = mobileActions(state);
    let renders = 0;
    runtime.render = () => { renders += 1; };

    actions.closeCompanion();
    assert.equal(state.companionSheetOpen, true, 'still rendered mid-exit-animation');
    assert.equal(state.companionSheetClosing, true);

    // Reopen before the 200ms close timer fires (e.g. a fast re-tap).
    mock.timers.tick(50);
    actions.openCompanion();
    assert.equal(state.companionSheetOpen, true);
    assert.equal(state.companionSheetClosing, false, 'reopen clears the stale closing flag');

    // Advance past the ORIGINAL close's 200ms mark — the stale timer must not
    // force the sheet shut out from under the fresh open.
    mock.timers.tick(200);
    assert.equal(state.companionSheetOpen, true, 'BUG: stale timer force-closed a reopened sheet');
    assert.equal(state.companionSheetClosing, false);
  } finally {
    mock.timers.reset();
  }
});

test('a rapid triple-tap close on the SAME sheet collapses to one real effect', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = { quickCaptureOpen: true, quickCaptureClosing: false };
    const actions = mobileActions(state);
    let renders = 0;
    runtime.render = () => { renders += 1; };

    actions.closeCapture();
    actions.closeCapture();
    actions.closeCapture();
    assert.equal(state.quickCaptureClosing, true);

    mock.timers.tick(200);
    assert.equal(state.quickCaptureOpen, false, 'the sheet does end up closed');
    assert.equal(state.quickCaptureClosing, false);
    assert.equal(renders, 1, 'only the first of the three stale timers should have any effect');
  } finally {
    mock.timers.reset();
  }
});

// ---- live/email.js: closeCompose (shared with desktop) -----------------------

test('starting a fresh compose mid-close cancels the pending force-close (mobile shell)', () => {
  mobileShell = true;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = { composeOpen: true, composeClosing: false, composeSubject: 'Re: old thread' };
    runtime.state = state;
    let renders = 0;
    runtime.render = () => { renders += 1; };

    emailActions.closeCompose();
    assert.equal(state.composeOpen, true);
    assert.equal(state.composeClosing, true);

    mock.timers.tick(50);
    emailActions.composeNew(); // user starts a brand-new draft mid-close
    assert.equal(state.composeOpen, true);
    assert.equal(state.composeClosing, false, 'reopen clears the stale closing flag');
    assert.equal(state.composeSubject, '', 'the fresh draft state took effect');

    mock.timers.tick(200);
    assert.equal(state.composeOpen, true, 'BUG: stale timer force-closed the fresh draft');
    assert.equal(state.composeClosing, false);
  } finally {
    mock.timers.reset();
  }
});

test('closeCompose on the desktop shell closes instantly — no animated delay (no *Closing read there)', () => {
  mobileShell = false;
  const state = { composeOpen: true, composeClosing: false };
  runtime.state = state;
  let renders = 0;
  runtime.render = () => { renders += 1; };

  emailActions.closeCompose();
  assert.equal(state.composeOpen, false, 'closes synchronously, not after a 200ms timer');
  assert.equal(state.composeClosing, false);
  assert.equal(renders, 1);
});

// ---- live/inbox.js: closeSnooze (shared with desktop) -------------------------

test('snoozing a different card mid-close cancels the pending force-close (mobile shell) — the exact repro from review', () => {
  mobileShell = true;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = { inboxSnoozeFor: 'A', inboxSnoozeClosing: false };
    runtime.state = state;
    let renders = 0;
    runtime.render = () => { renders += 1; };

    inboxActions.closeSnooze(); // cancel snooze on email A
    assert.equal(state.inboxSnoozeFor, 'A', 'still rendered mid-exit-animation');
    assert.equal(state.inboxSnoozeClosing, true);

    mock.timers.tick(50);
    inboxActions.snooze('B'); // within the window, open the menu for email B
    assert.equal(state.inboxSnoozeFor, 'B');
    assert.equal(state.inboxSnoozeClosing, false, 'reopen clears the stale closing flag');

    // Advance past A's original close's 200ms mark.
    mock.timers.tick(200);
    assert.equal(state.inboxSnoozeFor, 'B', "BUG: A's stale close timer force-closed B's menu");
    assert.equal(state.inboxSnoozeClosing, false);
  } finally {
    mock.timers.reset();
  }
});

test('closeSnooze on the desktop shell closes instantly — no animated delay (no *Closing read there)', () => {
  mobileShell = false;
  const state = { inboxSnoozeFor: '42', inboxSnoozeClosing: false };
  runtime.state = state;
  let renders = 0;
  runtime.render = () => { renders += 1; };

  inboxActions.closeSnooze();
  assert.equal(state.inboxSnoozeFor, null, 'closes synchronously, not after a 200ms timer');
  assert.equal(state.inboxSnoozeClosing, false);
  assert.equal(renders, 1);
});
