// Live tail of a still-running tool step.
//
// The gateway reports a tool call exactly twice (start, then result), so a
// long-running command shows nothing until it exits. A PreToolUse hook tees
// the command's output to a log keyed by the same tool id, and the step polls
// /api/toolstream for it. These cover the merge rules that polling depends on:
// offset advance, tail-trim, and the honest omitted count.

import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class {
  constructor(url) { this.url = String(url); this.readyState = 1; }
  close() { this.readyState = 2; }
};
globalThis.EventSource.CLOSED = 2;

const { applyTailChunk, TAIL_LINE_CAP } = await import('../redesign/live/chat.js');

const step = () => ({ state: 'running', lines: [], tailOffset: 0 });

test('a chunk appends its lines and advances the offset', () => {
  const st = step();
  const changed = applyTailChunk(st, { available: true, lines: ['tick 1', 'tick 2'], offset: 14 });
  assert.equal(changed, true);
  assert.deepEqual(st.lines.map((l) => l.t), ['tick 1', 'tick 2']);
  assert.equal(st.tailOffset, 14, 'next poll resumes where this one stopped');
  assert.equal(st.tailed, true, 'marks the step so the result frame can replace the preview');
});

test('a log with nothing new yet is not an update', () => {
  const st = step();
  assert.equal(applyTailChunk(st, { available: true, lines: [], offset: 0 }), false);
  assert.equal(st.lines.length, 0);
});

test('a missing log is not an update and never marks the step tailed', () => {
  const st = step();
  assert.equal(applyTailChunk(st, { available: false, lines: [], offset: 0 }), false);
  assert.ok(!st.tailed);
});

test('successive chunks accumulate rather than replace', () => {
  const st = step();
  applyTailChunk(st, { available: true, lines: ['a'], offset: 2 });
  applyTailChunk(st, { available: true, lines: ['b'], offset: 4 });
  assert.deepEqual(st.lines.map((l) => l.t), ['a', 'b']);
  assert.equal(st.tailOffset, 4);
});

test('output past the cap is tail-kept and the drop is counted honestly', () => {
  const st = step();
  const many = Array.from({ length: TAIL_LINE_CAP + 25 }, (_, i) => `L${i}`);
  applyTailChunk(st, { available: true, lines: many, offset: 999 });
  assert.equal(st.lines.length, TAIL_LINE_CAP, 'capped');
  assert.equal(st.omitted, 25, 'reports exactly how many were dropped');
  assert.equal(st.lines[st.lines.length - 1].t, `L${TAIL_LINE_CAP + 24}`,
    'keeps the MOST RECENT lines, like a scrollback buffer');
});

test("the server's own omitted count is added, not discarded", () => {
  const st = step();
  applyTailChunk(st, { available: true, lines: ['x'], offset: 2, omitted: 40 });
  assert.equal(st.omitted, 40);
});
