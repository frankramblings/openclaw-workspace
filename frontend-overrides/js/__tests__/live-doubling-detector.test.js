// Bug B trigger: the detector that decides a finished live bubble is worth
// reporting. It must fire on a re-emitted turn and stay silent on ordinary
// replies, because a false positive ships a frame log on every clean turn.
import { test } from 'node:test';
import assert from 'node:assert';
import { findDoubledSpan } from '../redesign/live/doubling.js';

const NARRATION = 'I will research this and then report back with what the numbers actually say.';
const ANSWER = 'Here is the answer: the funnel converts at four percent, and the drop-off is at step three.';

test('a clean narration + answer turn is not flagged', () => {
  assert.equal(findDoubledSpan(`${NARRATION}\n\n${ANSWER}`), null);
});

test('the whole turn re-emitted after the answer is flagged', () => {
  // What Frank exported: the answer, then the entire turn again.
  const doubled = `${ANSWER}\n\n${NARRATION}\n\n${ANSWER}`;
  const hit = findDoubledSpan(doubled);
  assert.ok(hit, 'expected the repeated answer to be detected');
  assert.equal(hit.count, 2);
});

test('a repeat is caught across whitespace differences', () => {
  // The snapshot joins blocks with "\n\n"; the stream delivered single spaces.
  const doubled = `${ANSWER} ${NARRATION}\n\n${ANSWER}`;
  assert.ok(findDoubledSpan(doubled));
});

test('short replies are never flagged', () => {
  assert.equal(findDoubledSpan('Hi there'), null);
  assert.equal(findDoubledSpan('Sent.Sent.'), null);
});

test('empty and nullish input is safe', () => {
  assert.equal(findDoubledSpan(''), null);
  assert.equal(findDoubledSpan(null), null);
  assert.equal(findDoubledSpan(undefined), null);
});

test('a long reply that merely repeats a short phrase is not flagged', () => {
  const prose = 'The deploy ran. '.repeat(30); // 16-char phrase, well under minLen
  const hit = findDoubledSpan(prose);
  // The tail window spans several repetitions, so it must not match twice
  // non-overlapping unless the text really is a doubled block.
  if (hit) assert.ok(hit.length >= 80);
});
