// Pure triage logic for the email modal. Run: node scripts/test-email-triage-math.mjs
import { toggleInSet, allSelected, chunk, summarizeBulk, triageMode }
  from '../frontend-overrides/js/emailLibrary/triageLogic.js';

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); failures++; } };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

{
  const s0 = new Set(['a']);
  const s1 = toggleInSet(s0, 'b');
  assert(s1 !== s0, 'toggleInSet returns a new set (no mutation)');
  eq([...s1].sort(), ['a', 'b'], 'toggleInSet adds missing uid');
  eq([...toggleInSet(s1, 'a')].sort(), ['b'], 'toggleInSet removes present uid');
}

assert(allSelected(['a', 'b'], new Set(['a', 'b'])) === true, 'allSelected true');
assert(allSelected(['a', 'b'], new Set(['a'])) === false, 'allSelected partial -> false');
assert(allSelected([], new Set()) === false, 'allSelected empty -> false');

eq(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'chunk by size');
eq(chunk([], 3), [], 'chunk empty -> []');

{
  const r = summarizeBulk([
    { uid: 'a', ok: true }, { uid: 'b', ok: false, error: 'x' }, { uid: 'c', ok: true },
  ]);
  eq(r, { ok: 2, failed: 1, failedUids: ['b'] }, 'summarizeBulk tallies');
}

assert(triageMode(1200) === 'split', 'triageMode wide -> split');
assert(triageMode(1100) === 'split', 'triageMode 1100 -> split (>=)');
assert(triageMode(1099) === 'stack', 'triageMode 1099 -> stack');
assert(triageMode(375) === 'stack', 'triageMode phone -> stack');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('email-triage-logic: all assertions passed');
