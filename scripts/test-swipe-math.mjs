// Extract the marked pure-math block from inbox.js and assert its behavior.
// No test runner exists for frontend code; this is the next best thing and
// runs in CI-less reality via: node scripts/test-swipe-math.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../frontend-overrides/js/inbox.js', import.meta.url), 'utf8');
const m = src.match(
  /\/\* SWIPE-MATH-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* SWIPE-MATH-END \*\//);
if (!m) { console.error('FAIL: SWIPE-MATH markers not found'); process.exit(1); }
const fns = new Function(
  m[1] + '; return { SWIPE, swipeRubber, swipeVelocity, swipeOutcome };')();

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL: ' + msg); failures++; }
};

// --- swipeRubber ------------------------------------------------------------
assert(fns.swipeRubber(50, 88) === 50, 'no resistance under max reveal');
assert(fns.swipeRubber(188, 88) === 88 + 100 * fns.SWIPE.RUBBER,
       'resistance past max');
assert(fns.swipeRubber(-188, 88) === -(88 + 100 * fns.SWIPE.RUBBER),
       'resistance symmetric on the left');
assert(fns.swipeRubber(0, 88) === 0, 'zero is zero');

// --- swipeVelocity ----------------------------------------------------------
assert(fns.swipeVelocity([{ x: 0, t: 0 }, { x: 60, t: 100 }]) === 0.6,
       'velocity = dx/dt px/ms');
assert(fns.swipeVelocity([{ x: 0, t: 0 }]) === 0, 'single sample -> 0');
assert(fns.swipeVelocity([]) === 0, 'no samples -> 0');
assert(fns.swipeVelocity([{ x: 0, t: 5 }, { x: 9, t: 5 }]) === 0,
       'zero dt cannot divide');
assert(fns.swipeVelocity([{ x: 100, t: 0 }, { x: 40, t: 100 }]) === -0.6,
       'leftward velocity is negative');

// --- swipeOutcome (card width 360 -> commit distance 216) -------------------
assert(fns.swipeOutcome(220, 0, 360) === 'commit', 'distance commit');
assert(fns.swipeOutcome(-220, 0, 360) === 'commit', 'left distance commit');
assert(fns.swipeOutcome(120, 0.7, 360) === 'commit', 'rightward flick commits');
assert(fns.swipeOutcome(-120, -0.7, 360) === 'commit', 'leftward flick commits');
assert(fns.swipeOutcome(120, -0.7, 360) === 'reveal',
       'flick against the offset does NOT commit');
assert(fns.swipeOutcome(8, 0.9, 360) === 'rest',
       'flick within the lock distance is noise');
assert(fns.swipeOutcome(60, 0, 360) === 'reveal', 'past half a zone -> reveal');
assert(fns.swipeOutcome(-60, 0, 360) === 'reveal', 'left reveal');
assert(fns.swipeOutcome(30, 0, 360) === 'rest', 'short drag rests');

if (failures) { console.error(`${failures} assert(s) failed`); process.exit(1); }
console.log('swipe-math: all asserts passed');
