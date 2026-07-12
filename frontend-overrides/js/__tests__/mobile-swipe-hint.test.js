// Task 3.4: swipe hint split. Right-swipe must reveal a left-aligned "✓
// <primary action>" hint; left-swipe a right-aligned "✕ Dismiss" hint — driven
// by drag direction, which mobile-app.js's pointermove handler applies as a
// class on the card wrap (mobile.css keys visibility/color off it). The
// direction→class mapping is pulled out as a pure function so it's testable
// without a DOM/pointer-event environment.
import { test } from 'node:test';
import assert from 'node:assert';
import { mInbox } from '../redesign/mobile/mobile-surfaces.js';

// mobile-app.js imports apiJson from live/api.js, which reads
// location.origin at module scope — same minimal shim other suites use
// (e.g. load-orchestration.test.js) to import a browser-shell module under
// plain Node. Dynamic import (not a static one) so the stub lands first.
globalThis.location = { origin: 'http://localhost' };
const { swipeDirClass } = await import('../redesign/mobile/mobile-app.js');

// ---- swipeDirClass (pure) ---------------------------------------------------

test('swipeDirClass: positive travel (right-swipe) → dir-right', () => {
  assert.strictEqual(swipeDirClass(40), 'dir-right');
});

test('swipeDirClass: negative travel (left-swipe) → dir-left', () => {
  assert.strictEqual(swipeDirClass(-40), 'dir-left');
});

test('swipeDirClass: zero travel → null (no hint before a real drag starts)', () => {
  assert.strictEqual(swipeDirClass(0), null);
});

// ---- mInbox swipe-card markup ----------------------------------------------

const item = (over) => ({
  id: '7', group: 'needs', who: 'Alex', time: '2h', src: 'GMAIL', srcColor: '#fff', srcBg: '#000',
  body: 'hello', unread: false, actions: ['archive'], ...over,
});

test('swipe card wraps the background hints in distinct act-right/act-left elements', () => {
  const html = mInbox({ live: { inbox: { items: [item()] } }, dismissed: [] });
  assert.match(html, /class="act act-right"/);
  assert.match(html, /class="act act-left"/);
});

test('right-swipe hint shows the real primary action label, not a generic placeholder', () => {
  const html = mInbox({ live: { inbox: { items: [item({ actions: ['archive'] })] } }, dismissed: [] });
  assert.match(html, /act-right">✓<span>Archive<\/span>/);
});

test('right-swipe hint tracks a different backend action (mark_read)', () => {
  const html = mInbox({ live: { inbox: { items: [item({ actions: ['mark_read'] })] } }, dismissed: [] });
  assert.match(html, /act-right">✓<span>Mark read<\/span>/);
});

test('left-swipe hint reads "Dismiss"', () => {
  const html = mInbox({ live: { inbox: { items: [item()] } }, dismissed: [] });
  assert.match(html, /act-left">✕<span>Dismiss<\/span>/);
});

test('calendar invites keep their RSVP-specific right hint, not a generic primary label', () => {
  const html = mInbox({ live: { inbox: { items: [item({ source: 'calendar', actions: ['rsvp'] })] } }, dismissed: [] });
  assert.match(html, /Tap Yes \/ Maybe \/ No/);
});
