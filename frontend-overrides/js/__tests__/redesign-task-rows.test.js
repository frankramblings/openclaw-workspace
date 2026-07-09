// Pin the one dynamic value in task-rows.js's innerHTML sink: task.kind,
// which is agent-derived (written into share/tasks/<id>/progress.json — see
// backend/workspace_files.py `/api/tasks/active`). taskRowHtml() only ever
// uses task.kind as a lookup key into the hardcoded KIND_COLOR map, so a
// hostile value must never reach the DOM as raw markup/attribute content —
// see Task 8 audit (docs/plans, .superpowers/sdd/task-8-report.md).
import { test } from 'node:test';
import assert from 'node:assert';
import { taskRowHtml } from '../redesign/task-rows.js';

test('XSS: hostile task.kind never reaches the row markup', () => {
  const hostile = '"><img src=x onerror=alert(1)>';
  const html = taskRowHtml({ id: 't1', kind: hostile });
  assert.doesNotMatch(html, /<img|onerror=/);
  assert.doesNotMatch(html, new RegExp(hostile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Falls back to the hardcoded default color, exactly like an unknown-but-benign kind.
  assert.match(html, /style="background:var\(--faint\)"/);
});

test('unknown task.kind falls back to the default color, not undefined', () => {
  const html = taskRowHtml({ id: 't2', kind: 'not-a-real-kind' });
  assert.match(html, /style="background:var\(--faint\)"/);
});

test('known task.kind selects its mapped color from the fixed whitelist', () => {
  const html = taskRowHtml({ id: 't3', kind: 'render' });
  assert.match(html, /style="background:var\(--gold\)"/);
});

test('prototype-chain kind names (e.g. "constructor") do not leak function bodies', () => {
  // KIND_COLOR is a plain object; without an explicit hasOwnProperty guard,
  // `KIND_COLOR['constructor']` resolves via the prototype chain to
  // Object's constructor function instead of the intended fallback.
  const html = taskRowHtml({ id: 't4', kind: 'constructor' });
  assert.match(html, /style="background:var\(--faint\)"/);
  assert.doesNotMatch(html, /function|native code/);
});

test('missing task.kind falls back to the default color', () => {
  const html = taskRowHtml({ id: 't5' });
  assert.match(html, /style="background:var\(--faint\)"/);
});
