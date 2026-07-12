// Task 3.1: mobile snooze bottom sheet. ⏰ tap / left-swipe already set
// state.inboxSnoozeFor (live/inbox.js's `snooze` action, shared with
// desktop) but mobile had no renderer for it — the desktop inline popover
// (surfaces.js inboxSurface) never runs on the phone shell. renderSnoozeSheet
// is the mobile counterpart: same presets/commit action, sheet chrome.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderSnoozeSheet } from '../redesign/mobile/mobile-sheets.js';

test('closed: no inboxSnoozeFor renders nothing', () => {
  assert.strictEqual(renderSnoozeSheet({}), '');
  assert.strictEqual(renderSnoozeSheet({ inboxSnoozeFor: null }), '');
  assert.strictEqual(renderSnoozeSheet(undefined), '');
});

test('open: renders the three presets wired to the shared snoozeFor commit action', () => {
  const html = renderSnoozeSheet({ inboxSnoozeFor: '42' });
  assert.match(html, /data-act="snoozeFor" data-arg="42:later"/);
  assert.match(html, /data-act="snoozeFor" data-arg="42:tomorrow"/);
  assert.match(html, /data-act="snoozeFor" data-arg="42:nextweek"/);
});

test('open: Cancel dispatches the shared closeSnooze action', () => {
  const html = renderSnoozeSheet({ inboxSnoozeFor: '42' });
  assert.match(html, /data-act="closeSnooze"/);
});

test('open: scrim also dismisses via closeSnooze (matches every other mobile sheet)', () => {
  const html = renderSnoozeSheet({ inboxSnoozeFor: '42' });
  assert.match(html, /class="m-scrim" data-act="closeSnooze"/);
});

test('id is escaped into data-arg (defensive — ids are normally numeric/opaque strings)', () => {
  const html = renderSnoozeSheet({ inboxSnoozeFor: '<x>' });
  assert.doesNotMatch(html, /data-arg="<x>:later"/);
  assert.match(html, /data-arg="&lt;x&gt;:later"/);
});

test('touch targets: preset rows carry the ≥44pt sheet-row class', () => {
  const html = renderSnoozeSheet({ inboxSnoozeFor: '42' });
  const rows = html.match(/class="m-snooze-row"/g) || [];
  assert.strictEqual(rows.length, 3);
});
