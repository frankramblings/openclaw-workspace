import { test } from 'node:test';
import assert from 'node:assert';
import { groupSteps, groupLabel, summarize } from '../redesign/chat-activity-group.js';

const step = (id, kind, state = 'done') => ({ id, kind, state, label: kind, lines: [] });

test('consecutive same-kind runs (>=2) group; a lone run stays single', () => {
  const items = groupSteps([
    step('a', 'read'),
    step('b', 'run'), step('c', 'run'), step('d', 'run'),
    step('e', 'read'),
  ]);
  assert.deepEqual(items.map((i) => i.type), ['single', 'group', 'single']);
  assert.equal(items[1].kind, 'run');
  assert.equal(items[1].steps.length, 3);
  assert.equal(items[1].id, 'g-b'); // id from first member
});

test('a running step never groups and breaks the current run', () => {
  const items = groupSteps([
    step('a', 'run'), step('b', 'run'),
    step('c', 'run', 'running'),
  ]);
  assert.deepEqual(items.map((i) => i.type), ['group', 'single']);
  assert.equal(items[1].step.id, 'c');
});

test('thinking steps never group', () => {
  const items = groupSteps([step('a', 'think'), step('b', 'think')]);
  assert.deepEqual(items.map((i) => i.type), ['single', 'single']);
});

test('all one kind collapses to a single group', () => {
  const items = groupSteps(Array.from({ length: 48 }, (_, i) => step('s' + i, 'run')));
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'group');
  assert.equal(items[0].steps.length, 48);
});

test('groupLabel is plural and kind-specific', () => {
  assert.equal(groupLabel('run', 11), 'Ran 11 commands');
  assert.equal(groupLabel('read', 2), 'Read 2 files');
  assert.equal(groupLabel('grep', 3), 'Searched 3 times');
});

test('summarize counts per kind in first-seen order, excludes thinking, tallies failures', () => {
  const out = summarize([
    step('t', 'think'),
    step('a', 'read'), step('b', 'read'), step('c', 'read'),
    step('d', 'grep'),
    step('e', 'run'), step('f', 'run', 'error'),
  ]);
  assert.deepEqual(out.parts, ['3 files read', '1 search', '2 commands']);
  assert.equal(out.failed, 1);
});
