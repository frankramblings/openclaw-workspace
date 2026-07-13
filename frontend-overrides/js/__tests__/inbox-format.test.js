// Date fixtures below are authored against UTC wall-clock (same discipline as
// scripts/test/inbox-logic.test.mjs). Must be set before any Date use.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  ageLabelFor, itemOriginMs, bodyIsPath, pointerRefLabel, srcStyle, chipRowHtml,
} from '../redesign/live/inbox-logic.js';
import { mInbox } from '../redesign/mobile/mobile-surfaces.js';
import { renderCenter } from '../redesign/surfaces.js';

test('srcStyle falls back to the real --mut token, not the undefined --muted', () => {
  assert.equal(srcStyle('some-unknown-source').srcColor, 'var(--mut)');
  assert.notEqual(srcStyle('some-unknown-source').srcColor, 'var(--muted)');
});

// ---- ageLabelFor: honest ages off the item's REAL origin timestamp ---------
// (task 5.1b — the backend's ageHours is stamped when the collector runs, so
// rendering it said "now" for everything fresh-ingested.)

const NOW = Date.parse('2026-07-13T12:00:00Z');

test('ageLabelFor uses the cross-source ts contract, minute-grained', () => {
  assert.equal(ageLabelFor({ source: 'gmail', ts: NOW - 30 * 1000 }, NOW), 'now');
  assert.equal(ageLabelFor({ source: 'gmail', ts: NOW - 5 * 60000 }, NOW), '5m');
  assert.equal(ageLabelFor({ source: 'slack', ts: NOW - 5 * 3600000 }, NOW), '5h');
  assert.equal(ageLabelFor({ source: 'asana', ts: NOW - 3 * 86400000 }, NOW), '3d');
});

test('ageLabelFor prefers a real meta timestamp over ts', () => {
  const item = { source: 'gmail', ts: NOW, meta: { receivedAt: '2026-07-13T10:00:00Z' } };
  assert.equal(ageLabelFor(item, NOW), '2h');
  const viaDate = { source: 'gmail', ts: NOW, meta: { date: NOW - 3600000 } };
  assert.equal(ageLabelFor(viaDate, NOW), '1h');
});

test('ageLabelFor renders week-plus items as a date, year only when it differs', () => {
  assert.equal(ageLabelFor({ source: 'gmail', ts: Date.parse('2026-06-15T12:00:00Z') }, NOW), 'Jun 15');
  assert.equal(ageLabelFor({ source: 'gmail', ts: Date.parse('2025-11-02T12:00:00Z') }, NOW), 'Nov 2 2025');
});

test('ageLabelFor is honest about the future (calendar starts)', () => {
  assert.equal(ageLabelFor({ source: 'calendar', meta: { start: '2026-07-13T15:00:00Z' } }, NOW), 'in 3h');
});

test('ageLabelFor renders an em-dash, never a fake now, when no origin exists', () => {
  // entities items: the backend stamps ts at SCAN time — not a real origin.
  assert.equal(ageLabelFor({ source: 'entities', ts: NOW }, NOW), '—');
  assert.equal(itemOriginMs({ source: 'entities', ts: NOW }), null);
  // no timestamp at all
  assert.equal(ageLabelFor({ source: 'gmail' }, NOW), '—');
  assert.equal(ageLabelFor({}, NOW), '—');
});

// ---- zero-count filter chips are hidden (task 5.1c) -------------------------

test('chipRowHtml hides zero-count sources unless filtered on or errored', () => {
  const escFn = (x) => String(x);
  const counts = { all: 5, GMAIL: 5, SLACK: 0 };
  const html = chipRowHtml(counts, {}, escFn);
  assert.match(html, /gmail 5/);
  assert.doesNotMatch(html, /slack/, 'zero-count chip is hidden');
  // actively filtered on → stays visible so it can be un-toggled
  const filtered = chipRowHtml(counts, { filter: 'SLACK' }, escFn);
  assert.match(filtered, /slack 0/);
  // errored → stays visible so the ⚠ has somewhere to live
  const errored = chipRowHtml({ all: 5, GMAIL: 5 }, { errors: { slack: 'boom' } }, escFn);
  assert.match(errored, /slack/);
  assert.match(errored, /chip-warn/);
});

test('bodyIsPath detects ingest source pointers, not prose', () => {
  assert.equal(bodyIsPath('99_Ingest/Processed/gmail_important_latest.jsonl#L2'), true);
  assert.equal(bodyIsPath('99_Ingest/Processed/asana_tasks_latest.json#L2-L9'), true);
  assert.equal(bodyIsPath('Hey, can you review the doc before Friday?'), false);
  assert.equal(bodyIsPath('Boosted Social Campaign Brief'), false);
  assert.equal(bodyIsPath(''), false);
});

// ---- pointer bodies render as a subtle ref, not body copy (task 5.1a) ------

test('pointerRefLabel keeps just the source file name, no dirs, no #L suffix', () => {
  assert.equal(pointerRefLabel('99_Ingest/Processed/gmail_important_latest.jsonl#L2'),
    'gmail_important_latest.jsonl');
  assert.equal(pointerRefLabel('99_Ingest/Processed/asana_tasks_latest.json#L2-L9'),
    'asana_tasks_latest.json');
  assert.equal(pointerRefLabel('notes.md'), 'notes.md');
});

test('both shells suppress the raw pointer to a ref label with the pointer in the tooltip', () => {
  const ptr = '99_Ingest/Processed/gmail_important_latest.jsonl#L2';
  const mob = mInbox({ dismissed: [], live: { inbox: { items: [item(ptr)] } } });
  const desk = renderCenter({ surface: 'inbox', dismissed: [], live: { inbox: { items: [item(ptr)] } } });
  for (const html of [mob, desk]) {
    assert.match(html, /title="99_Ingest\/Processed\/gmail_important_latest\.jsonl#L2"/,
      'full pointer kept for debugging in the title attr');
    assert.match(html, />gmail_important_latest\.jsonl</, 'only the file name shows');
    assert.doesNotMatch(html, />99_Ingest\//, 'raw pointer never renders as body text');
  }
});

// ---- clock affordances are the SVG icon, not emoji (task 5.1d) --------------

test('inbox surface carries no emoji clocks and a nowrap History button', () => {
  const s = {
    surface: 'inbox', dismissed: [],
    live: { inbox: { items: [
      item('a body'),
      { ...item('Marissa'), id: 'e1', source: 'entities', meta: { name: 'Marissa', guessType: 'person' } },
    ] } },
  };
  const html = renderCenter(s);
  assert.doesNotMatch(html, /⏰/, 'entity-card snooze uses the SVG clock');
  assert.doesNotMatch(html, /⏱/, 'History button uses the SVG clock');
  assert.match(html, /btn-hist/, 'History button has its flex/nowrap class');
});

const item = (body) => ({
  id: '1', source: 'gmail', group: 'needs', src: 'GMAIL', srcColor: '#fff', srcBg: '#333',
  who: 'Dana Hu', time: 'now', body, actions: [], rec: null, meta: {},
  primary: 'Open', secondary: 'Mark read', suggest: 'Archive', unread: false,
});

test('mobile inbox renders path bodies as a source line, prose as body', () => {
  const s = (b) => ({ dismissed: [], live: { inbox: { items: [item(b)] } } });
  assert.match(mInbox(s('99_Ingest/Processed/gmail_important_latest.jsonl#L2')), /body-src/);
  assert.doesNotMatch(mInbox(s('Please review the brief.')), /body-src/);
});

test('desktop inbox renders path bodies as a source line', () => {
  const s = { surface: 'inbox', dismissed: [], live: { inbox: { items: [item('99_Ingest/Processed/gmail_important_latest.jsonl#L2')] } } };
  assert.match(renderCenter(s), /body-src/);
});

// The FYI card's "✦ suggest" pill interpolated it.id straight into the
// data-arg attribute with no esc() — the one un-escaped attribute-arg site
// left in surfaces.js (everywhere else already ran ids through esc()).
test('the FYI card\'s applyRec pill escapes it.id in the data-arg attribute', () => {
  const fyi = {
    id: '1"><script>bad()</script>', group: 'fyi', source: 'gmail',
    src: 'GMAIL', srcColor: '#fff', srcBg: '#333', who: 'Sender', time: 'now',
    body: 'A newsletter.', suggest: 'Archive — newsletter', aiArchive: true, actions: [],
  };
  const s = { surface: 'inbox', dismissed: [], live: { inbox: { items: [fyi] } } };
  const html = renderCenter(s);
  assert.doesNotMatch(html, /data-act="applyRec" data-arg="1"><script>/);
  assert.match(html, /data-act="applyRec" data-arg="1&quot;&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;"/);
});
