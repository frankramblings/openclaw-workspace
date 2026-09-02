import { test } from 'node:test';
import assert from 'node:assert';
import {
  saveDraft, restoreDraft, dropDraft, capDrafts, loadDrafts, persistDrafts,
  scrollSnapshot, scrollDecision, pushMru, loadMru, persistMru,
  DRAFT_KEY, MRU_KEY, DRAFT_CAP, MRU_CAP,
} from '../redesign/live/thread-switch.js';

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

test('saveDraft stores text keyed by id and does not mutate input', () => {
  const d0 = {};
  const d1 = saveDraft(d0, 'a', 'hello', 100);
  assert.deepEqual(d0, {});
  assert.deepEqual(d1, { a: { text: 'hello', at: 100 } });
  assert.equal(restoreDraft(d1, 'a'), 'hello');
  assert.equal(restoreDraft(d1, 'b'), '');
  assert.equal(restoreDraft(null, 'a'), '');
});

test('saveDraft with blank text removes the entry; null id is a no-op', () => {
  const d1 = saveDraft({}, 'a', 'x', 1);
  assert.deepEqual(saveDraft(d1, 'a', '   ', 2), {});
  assert.deepEqual(saveDraft(d1, null, 'y', 2), d1);
});

test('dropDraft removes only that id', () => {
  const d = { a: { text: 'x', at: 1 }, b: { text: 'y', at: 2 } };
  assert.deepEqual(dropDraft(d, 'a'), { b: { text: 'y', at: 2 } });
  assert.deepEqual(dropDraft(d, null), d);
});

test('capDrafts keeps the newest DRAFT_CAP entries', () => {
  const d = {};
  for (let i = 0; i < DRAFT_CAP + 5; i++) d[`s${i}`] = { text: 't', at: i };
  const capped = capDrafts(d);
  assert.equal(Object.keys(capped).length, DRAFT_CAP);
  assert.ok(!('s0' in capped));
  assert.ok(`s${DRAFT_CAP + 4}` in capped);
});

test('drafts round-trip through storage and tolerate junk', () => {
  const st = memStorage();
  persistDrafts({ a: { text: 'x', at: 1 } }, st);
  assert.equal(st.getItem(DRAFT_KEY), JSON.stringify({ a: { text: 'x', at: 1 } }));
  assert.deepEqual(loadDrafts(st), { a: { text: 'x', at: 1 } });
  assert.deepEqual(loadDrafts(memStorage({ [DRAFT_KEY]: '{not json' })), {});
  assert.deepEqual(loadDrafts(memStorage({ [DRAFT_KEY]: '[1,2]' })), {});
  assert.deepEqual(loadDrafts({ getItem: () => { throw new Error('nope'); } }), {});
  assert.doesNotThrow(() => persistDrafts({}, { setItem: () => { throw new Error('quota'); } }));
});

test('scrollSnapshot flags at-bottom within 16px', () => {
  assert.deepEqual(scrollSnapshot(984, 1000, 16), { top: 984, atBottom: true });
  assert.deepEqual(scrollSnapshot(900, 1000, 16), { top: 900, atBottom: false });
  assert.deepEqual(scrollSnapshot(-3, 60, 50), { top: 0, atBottom: true });
});

test('scrollDecision: bottom when no snapshot, at bottom, or finished while away', () => {
  assert.deepEqual(scrollDecision(null, false), { bottom: true, top: null });
  assert.deepEqual(scrollDecision({ top: 900, atBottom: true }, false), { bottom: true, top: null });
  assert.deepEqual(scrollDecision({ top: 900, atBottom: false }, true), { bottom: true, top: null });
  assert.deepEqual(scrollDecision({ top: 900, atBottom: false }, false), { bottom: false, top: 900 });
});

test('pushMru moves id to the front, dedupes, caps', () => {
  assert.deepEqual(pushMru(['b', 'a'], 'a'), ['a', 'b']);
  assert.deepEqual(pushMru([], 'a'), ['a']);
  assert.deepEqual(pushMru(['a'], null), ['a']);
  const long = Array.from({ length: MRU_CAP }, (_, i) => `s${i}`);
  const next = pushMru(long, 'new');
  assert.equal(next.length, MRU_CAP);
  assert.equal(next[0], 'new');
  assert.ok(!next.includes(`s${MRU_CAP - 1}`));
});

test('mru round-trips through storage and tolerates junk', () => {
  const st = memStorage();
  persistMru(['a', 'b'], st);
  assert.equal(st.getItem(MRU_KEY), '["a","b"]');
  assert.deepEqual(loadMru(st), ['a', 'b']);
  assert.deepEqual(loadMru(memStorage({ [MRU_KEY]: '{"x":1}' })), []);
  assert.deepEqual(loadMru(memStorage({ [MRU_KEY]: '["a", 5, null]' })), ['a']);
});
