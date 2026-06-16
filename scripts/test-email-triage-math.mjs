// Extract the marked pure-logic block from emailInbox.js and assert its
// behavior. No frontend test runner exists; run via:
//   node scripts/test-email-triage-math.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../frontend-overrides/js/emailInbox.js', import.meta.url), 'utf8');
const m = src.match(
  /\/\* EMAIL-TRIAGE-MATH-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* EMAIL-TRIAGE-MATH-END \*\//);
if (!m) { console.error('FAIL: EMAIL-TRIAGE-MATH markers not found'); process.exit(1); }
const T = new Function(
  m[1] + '; return { triageMode, toggleInSet, allSelected, nextIndex, chunk, summarizeBulk };')();

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); failures++; } };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

// triageMode: width -> layout
assert(T.triageMode(1200) === 'split', 'wide is split');
assert(T.triageMode(900) === 'split', '900 is split (>=)');
assert(T.triageMode(899) === 'stack', '899 is stack');
assert(T.triageMode(375) === 'stack', 'phone is stack');

// toggleInSet: returns a NEW Set, adds/removes
{
  const s0 = new Set(['a']);
  const s1 = T.toggleInSet(s0, 'b');
  assert(s1 !== s0, 'returns a new set (no mutation)');
  eq([...s1].sort(), ['a', 'b'], 'adds missing uid');
  eq([...T.toggleInSet(s1, 'a')].sort(), ['b'], 'removes present uid');
}

// allSelected
assert(T.allSelected(['a', 'b'], new Set(['a', 'b'])) === true, 'all selected true');
assert(T.allSelected(['a', 'b'], new Set(['a'])) === false, 'partial -> false');
assert(T.allSelected([], new Set()) === false, 'empty list -> false');

// nextIndex: wraps both directions
assert(T.nextIndex(0, 3, 1) === 1, 'down');
assert(T.nextIndex(2, 3, 1) === 0, 'down wraps to 0');
assert(T.nextIndex(0, 3, -1) === 2, 'up wraps to last');
assert(T.nextIndex(-1, 3, 1) === 0, 'no selection + down -> first');
assert(T.nextIndex(5, 0, 1) === -1, 'empty list -> -1');

// chunk: batches for concurrency
eq(T.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'chunks by size');
eq(T.chunk([], 3), [], 'empty -> []');

// summarizeBulk: tally ok/failed from settled results
{
  const r = T.summarizeBulk([
    { uid: 'a', ok: true }, { uid: 'b', ok: false, error: 'x' }, { uid: 'c', ok: true },
  ]);
  eq(r, { ok: 2, failed: 1, failedUids: ['b'] }, 'tallies results');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('email-triage-math: all assertions passed');
