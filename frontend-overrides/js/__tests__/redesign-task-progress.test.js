// resolveProgress() is the whole "is this a bar or a tracker?" decision, in
// one pure function so the renderer never guesses. The producer sets
// progress.mode because only it knows whether it has a denominator; the UI
// switches on the resolved descriptor. Back-compat: a task with no `progress`
// field falls through to the legacy scalar `pct` (the download bar that's
// already live must not regress).
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveProgress, stepsRailHtml } from '../redesign/task-rows.js';

test('legacy: no progress field falls back to scalar pct as a determinate bar', () => {
  const r = resolveProgress({ id: 't', pct: 42 });
  assert.equal(r.mode, 'determinate');
  assert.equal(r.pct, 42);
  assert.equal(r.showBar, true);
  assert.equal(r.showPct, true);
});

test('legacy: missing pct is an honest spinner, not a 0% bar', () => {
  // A missing pct has no denominator, same as an explicit 0 — it must not
  // render as a determinate bar parked at zero (that's the zombie-row bug
  // this task fixes). Finite pct is still guaranteed, just via the spinner.
  const r = resolveProgress({ id: 't' });
  assert.equal(r.mode, 'indeterminate');
  assert.equal(r.showBar, false);
  assert.equal(r.pct, 0);
  assert.ok(Number.isFinite(r.pct));
});

test('determinate descriptor computes pct from done/total', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'determinate', done: 142, total: 166 } });
  assert.equal(r.mode, 'determinate');
  assert.ok(Math.abs(r.pct - 85.542) < 0.01, `pct was ${r.pct}`);
  assert.equal(r.showBar, true);
  assert.equal(r.showPct, true);
});

test('determinate descriptor with total 0 is an honest spinner, never a divide-by-zero bar', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'determinate', done: 0, total: 0 } });
  assert.equal(r.mode, 'indeterminate');
  assert.equal(r.showBar, false);
  assert.equal(r.pct, 0);
  assert.ok(Number.isFinite(r.pct));
});

test('determinate descriptor clamps pct to 0..100 when done exceeds total', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'determinate', done: 200, total: 166 } });
  assert.equal(r.pct, 100);
});

test('indeterminate descriptor shows no bar and no percent, carries detail', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'indeterminate', detail: 'checking URLs…' } });
  assert.equal(r.mode, 'indeterminate');
  assert.equal(r.showBar, false);
  assert.equal(r.showPct, false);
  assert.equal(r.detail, 'checking URLs…');
});

test('steps: active phase carries a resolved determinate leaf', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'steps', active: 'download', steps: [
    { key: 'ingest',   label: 'Ingest',   status: 'done' },
    { key: 'download', label: 'Download', status: 'active',
      progress: { mode: 'determinate', done: 142, total: 166 } },
    { key: 'verify',   label: 'Verify',   status: 'pending' },
  ] } });
  assert.equal(r.mode, 'steps');
  assert.equal(r.steps.length, 3);
  assert.equal(r.active, 'download');
  const dl = r.steps.find((s) => s.key === 'download');
  assert.equal(dl.inner.mode, 'determinate');
  assert.ok(Math.abs(dl.inner.pct - 85.542) < 0.01);
});

test('steps: active resolves from the first active step when no active key is set', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'steps', steps: [
    { key: 'a', status: 'done' },
    { key: 'b', status: 'active', progress: { mode: 'indeterminate', detail: 'working…' } },
    { key: 'c', status: 'pending' },
  ] } });
  assert.equal(r.active, 'b');
  const b = r.steps.find((s) => s.key === 'b');
  assert.equal(b.inner.mode, 'indeterminate');
});

test('steps: a step with no progress descriptor is atomic (inner null)', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'steps', steps: [
    { key: 'a', status: 'done' },
    { key: 'b', status: 'active' },
  ] } });
  const a = r.steps.find((s) => s.key === 'a');
  assert.equal(a.inner, null);
});

test('stepsRailHtml renders one dot per phase with status + active classes', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'steps', active: 'download', steps: [
    { key: 'ingest',   label: 'Ingest',   status: 'done' },
    { key: 'download', label: 'Download', status: 'active', progress: { mode: 'determinate', done: 1, total: 4 } },
    { key: 'verify',   label: 'Verify',   status: 'pending' },
  ] } });
  const html = stepsRailHtml(r);
  assert.match(html, /task-step done/);
  assert.match(html, /task-step active/);
  assert.match(html, /task-step pending/);
  assert.match(html, /Ingest/);
  assert.match(html, /Download/);
  assert.match(html, /Verify/);
});

test('stepsRailHtml escapes hostile phase labels — no raw markup reaches the sink', () => {
  const r = resolveProgress({ id: 't', progress: { mode: 'steps', steps: [
    { key: 'x', label: '"><img src=x onerror=alert(1)>', status: 'active' },
  ] } });
  const html = stepsRailHtml(r);
  assert.doesNotMatch(html, /<img/);     // no live tag reaches the sink
  assert.match(html, /&lt;img/);         // the payload was neutralized, not dropped
});

test('stepsRailHtml on a non-steps descriptor returns empty string', () => {
  assert.equal(stepsRailHtml(resolveProgress({ id: 't', pct: 50 })), '');
});
