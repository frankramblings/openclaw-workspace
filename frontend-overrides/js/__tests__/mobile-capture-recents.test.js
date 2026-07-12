// Task 3.6: quick-capture honesty. The sheet used to ship two lies: a
// hardcoded "RECENT CAPTURES" list (two mock rows that never changed) and a
// fake live "Gary parsed: ..." preview keyed only off captureType — neither
// reflected anything the user actually typed or sent. Real recents now come
// from a localStorage-backed list written on a successful sendCapture.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderCaptureSheet } from '../redesign/mobile/mobile-sheets.js';
import {
  pushRecentCapture, readRecentCaptures, writeRecentCaptures, recordCapture, captureAgeLabel,
} from '../redesign/mobile/mobile-data.js';

// ---- pure list/storage helpers ---------------------------------------------

test('pushRecentCapture prepends and caps at 5', () => {
  const list = [1, 2, 3, 4, 5].map((n) => ({ text: String(n) }));
  const next = pushRecentCapture(list, { text: '6' });
  assert.strictEqual(next.length, 5);
  assert.strictEqual(next[0].text, '6');
  assert.strictEqual(next[4].text, '4', 'oldest entry falls off the cap');
});

test('pushRecentCapture tolerates a missing/non-array list', () => {
  const next = pushRecentCapture(null, { text: 'first' });
  assert.deepStrictEqual(next, [{ text: 'first' }]);
});

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

test('readRecentCaptures: empty/missing storage → []', () => {
  assert.deepStrictEqual(readRecentCaptures(null), []);
  assert.deepStrictEqual(readRecentCaptures(fakeStorage()), []);
});

test('readRecentCaptures: corrupt JSON → [] (never throws)', () => {
  const storage = fakeStorage();
  storage.setItem('gary.recentCaptures', '{not json');
  assert.deepStrictEqual(readRecentCaptures(storage), []);
});

test('recordCapture writes through and readRecentCaptures reflects it', () => {
  const storage = fakeStorage();
  const list = recordCapture(storage, { text: 'Call the vet', type: 'remind', ts: 1000 });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].text, 'Call the vet');
  assert.strictEqual(list[0].type, 'remind');
  assert.deepStrictEqual(readRecentCaptures(storage), list);
});

test('recordCapture accumulates newest-first across multiple calls', () => {
  const storage = fakeStorage();
  recordCapture(storage, { text: 'first', type: 'note', ts: 1 });
  const list = recordCapture(storage, { text: 'second', type: 'task', ts: 2 });
  assert.strictEqual(list[0].text, 'second');
  assert.strictEqual(list[1].text, 'first');
});

test('writeRecentCaptures never throws when storage is missing', () => {
  assert.doesNotThrow(() => writeRecentCaptures(null, [{ text: 'x' }]));
});

test('captureAgeLabel: relative age buckets', () => {
  const now = 1_000_000;
  assert.strictEqual(captureAgeLabel(now - 10_000, now), 'now');
  assert.strictEqual(captureAgeLabel(now - 5 * 60000, now), '5m');
  assert.strictEqual(captureAgeLabel(now - 3 * 3600000, now), '3h');
  assert.strictEqual(captureAgeLabel(now - 2 * 86400000, now), '2d');
});

// ---- renderer: renderCaptureSheet ------------------------------------------

test('no captureDraft: no speculative parse preview at all (honesty rule — captureDraft is a PLAIN_SHEET_FIELDS skip field, a live preview would visibly not track keystrokes)', () => {
  const html = renderCaptureSheet({ captureType: 'remind', captureDraft: 'send the deck to legal' });
  assert.doesNotMatch(html, /parsed:/i);
  assert.doesNotMatch(html, /m-cap-parse/);
});

test('the old fake parse strings are gone for every capture type', () => {
  for (const type of ['remind', 'task', 'note', 'research']) {
    const html = renderCaptureSheet({ captureType: type, captureDraft: 'anything' });
    assert.doesNotMatch(html, /Reminder · Fri 9:00 AM/);
    assert.doesNotMatch(html, /Task · no due date/);
    assert.doesNotMatch(html, /Note · notes\/quick\.md/);
    assert.doesNotMatch(html, /Research · queued/);
  }
});

test('no recents: honest empty state, no mock rows', () => {
  const html = renderCaptureSheet({ captureType: 'remind', captureDraft: '' });
  assert.doesNotMatch(html, /Book Sea Dogs tickets/);
  assert.doesNotMatch(html, /Compare podcast hosting platforms/);
  assert.match(html, /m-cap-recent-empty/);
});

test('real recents render, escaped', () => {
  const html = renderCaptureSheet({
    captureType: 'remind',
    captureDraft: '',
    captureRecents: [
      { text: 'Call <the> vet & confirm', type: 'remind', ts: Date.now() },
      { text: 'Buy milk', type: 'task', ts: Date.now() - 60000 },
    ],
  });
  assert.match(html, /Call &lt;the&gt; vet &amp; confirm/);
  assert.doesNotMatch(html, /Call <the> vet/);
  assert.match(html, /Buy milk/);
  assert.doesNotMatch(html, /m-cap-recent-empty/);
});

test('recents type renders a real label (Remind/Task/Note/Research), not a raw id', () => {
  const html = renderCaptureSheet({
    captureType: 'remind', captureDraft: '',
    captureRecents: [{ text: 'x', type: 'research', ts: Date.now() }],
  });
  assert.match(html, /Research/);
});
