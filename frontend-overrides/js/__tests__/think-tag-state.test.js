import { test } from 'node:test';
import assert from 'node:assert';
import { newThinkTagState, advanceThinkTags } from '../think-tag-state.js';

// Reference implementation = the ORIGINAL inline logic, verbatim, operating on a
// full `accumulated` string. The new incremental version must produce identical
// output deltas for any sequence of chunks.
function referenceRun(chunks) {
  let accumulated = '';
  const outDeltas = [];
  for (const { delta, thinking } of chunks) {
    let _delta = delta;
    if (thinking) {
      if (!accumulated.includes('<think>')) _delta = '<think>' + _delta;
    } else if (accumulated.includes('<think>') && !accumulated.includes('</think>')) {
      _delta = '</think>' + _delta;
    }
    accumulated += _delta;
    outDeltas.push(_delta);
  }
  return outDeltas;
}

function incrementalRun(chunks) {
  const state = newThinkTagState();
  return chunks.map(({ delta, thinking }) => advanceThinkTags(state, delta, !!thinking));
}

function assertEquivalent(chunks, label) {
  assert.deepStrictEqual(incrementalRun(chunks), referenceRun(chunks), label);
}

test('plain non-thinking stream: no tags injected', () => {
  assertEquivalent(
    [{ delta: 'Hello ' }, { delta: 'there ' }, { delta: 'world' }],
    'plain',
  );
});

test('synthetic thinking wrap: opens once, closes on first non-thinking delta', () => {
  assertEquivalent(
    [
      { delta: 'reasoning a', thinking: true },
      { delta: ' reasoning b', thinking: true },
      { delta: 'Final answer', thinking: false },
      { delta: ' continues', thinking: false },
    ],
    'synthetic wrap',
  );
});

test('native <think> tags already in content are not double-wrapped', () => {
  assertEquivalent(
    [
      { delta: '<think>internal', thinking: false },
      { delta: ' monologue</think>', thinking: false },
      { delta: 'visible reply', thinking: false },
    ],
    'native tags',
  );
});

test('tag split across delta boundary is still detected', () => {
  // '<think>' split as '<thi' + 'nk>' — naive delta.includes() would miss it,
  // but the carry tail catches it, matching accumulated.includes().
  assertEquivalent(
    [
      { delta: '<thi', thinking: false },
      { delta: 'nk>hidden', thinking: false },
      { delta: 'reply', thinking: true }, // must NOT re-wrap: <think> already seen
    ],
    'split open tag',
  );
});

test('close tag split across boundary is detected', () => {
  assertEquivalent(
    [
      { delta: 'x', thinking: true }, // wraps -> <think>x
      { delta: 'more', thinking: true },
      { delta: '</thi', thinking: false }, // wraps close -> </think></thi
      { delta: 'nk>tail', thinking: false },
      { delta: 'again', thinking: false },
    ],
    'split close tag',
  );
});

test('thinking with no following non-thinking delta (never closes)', () => {
  assertEquivalent(
    [
      { delta: 'a', thinking: true },
      { delta: 'b', thinking: true },
    ],
    'never closes',
  );
});

test('interleaved thinking/non-thinking around close boundary', () => {
  assertEquivalent(
    [
      { delta: 'r1', thinking: true },
      { delta: 'ans', thinking: false }, // closes here
      { delta: ' r2', thinking: true },  // sawOpen already true -> no re-wrap
      { delta: ' more', thinking: false }, // sawClose true -> no re-wrap
    ],
    'interleaved',
  );
});

test('empty deltas do not corrupt state', () => {
  assertEquivalent(
    [
      { delta: '', thinking: false },
      { delta: '', thinking: true },
      { delta: 'hi', thinking: true },
      { delta: '', thinking: false },
      { delta: 'done', thinking: false },
    ],
    'empty deltas',
  );
});
