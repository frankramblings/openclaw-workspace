import { test } from 'node:test';
import assert from 'node:assert';
import { mMore } from '../redesign/mobile/mobile-surfaces.js';
import { renderCenter } from '../redesign/surfaces.js';

test('More grid shows live counts when data is loaded', () => {
  const html = mMore({ live: {
    notes: { docs: [{}] },
    research: { past: [{}, {}] },
    library: { items: [{}, {}, {}] },
    calendar: { agenda: [{ label: 'TODAY · FRI JUL 10', events: [{}, {}] }] },
  } });
  assert.match(html, /1 in vault/);
  assert.match(html, /2 reports/);
  assert.match(html, /3 artifacts/);
  assert.match(html, /2 events today/);
});

test('More grid singularizes one event', () => {
  const html = mMore({ live: { calendar: { agenda: [{ label: 'TODAY · X', events: [{}] }] } } });
  assert.match(html, /1 event today/);
});

test('More grid shows no fabricated counts before data loads', () => {
  const html = mMore({ live: {} });
  assert.doesNotMatch(html, /41 in vault/);
  assert.doesNotMatch(html, /24 artifacts/);
  assert.doesNotMatch(html, /7 reports/);
  assert.doesNotMatch(html, /5 jobs/);
  assert.doesNotMatch(html, /3 events today/);
});

const noteDoc = { title: 'Swamp Thing 2', version: 1, meta: 'Updated Jun 16 · 313 words', path: 'notes/swamp-thing-2.md', blocks: [] };

test('notes list header counts the real vault, not a hardcoded 41', () => {
  const html = renderCenter({ surface: 'notes', selDoc: 0, notesFilter: '', live: { notes: { docs: [noteDoc] } } });
  assert.match(html, /vault · 1/);
  assert.doesNotMatch(html, /vault · 41/);
});

test('notes editor drops the dead History pill', () => {
  const html = renderCenter({ surface: 'notes', selDoc: 0, notesFilter: '', live: { notes: { docs: [noteDoc] } } });
  assert.doesNotMatch(html, /note-hist/);
});
