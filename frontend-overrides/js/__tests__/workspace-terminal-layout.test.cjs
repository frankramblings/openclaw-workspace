const test = require('node:test');
const assert = require('node:assert');
const { computeStack, orderVisible } = require('../workspace-terminal-layout.cjs');

test('computeStack right-anchors with base offset and sums widths', () => {
  // ordered right->left: A (rightmost) then B then C (leftmost)
  const { positions, totalWidth } = computeStack(
    [{ id: 'A', width: 100 }, { id: 'B', width: 200 }, { id: 'C', width: 300 }], 50);
  assert.equal(positions.A, 50);          // base offset
  assert.equal(positions.B, 150);         // 50 + 100
  assert.equal(positions.C, 350);         // 50 + 100 + 200
  assert.equal(totalWidth, 600);          // excludes base offset
});

test('computeStack with no base offset', () => {
  const { positions, totalWidth } = computeStack([{ id: 'X', width: 400 }], 0);
  assert.equal(positions.X, 0);
  assert.equal(totalWidth, 400);
});

test('computeStack empty', () => {
  const { positions, totalWidth } = computeStack([], 0);
  assert.deepEqual(positions, {});
  assert.equal(totalWidth, 0);
});

test('orderVisible: pins right->left then active unpinned leftmost', () => {
  // pinnedRightToLeft index 0 = rightmost (oldest pin); active unpinned is leftmost
  assert.deepEqual(orderVisible(['A', 'B'], 'Z'), ['A', 'B', 'Z']);
  assert.deepEqual(orderVisible(['A'], null), ['A']);
  assert.deepEqual(orderVisible([], 'Z'), ['Z']);
  assert.deepEqual(orderVisible([], null), []);
});
