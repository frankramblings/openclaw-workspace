import { test } from 'node:test';
import assert from 'node:assert';
import { overlayJobs, jobHtml } from '../redesign/live/jobs.js';

const rec = (over = {}) => ({
  id: 'job:r566', kind: 'job', source: 'job', label: 'render 566',
  session_key: null, turn_id: null, state: 'running', pct: 55, eta: 60,
  detail: 'frame 300/540', error: '', created: 1, updated: 2,
  extra: { native: { id: 'r566', label: 'render 566', status: 'running', pct: 55, bytesDone: 10, thread: 'abc' } },
  ...over,
});

test('job records map to native overlay shape', () => {
  const [j] = overlayJobs([rec()]);
  assert.equal(j.id, 'r566');
  assert.equal(j.bytesDone, 10);          // arbitrary native fields survive
  assert.equal(j.thread, 'abc');          // "mine" highlighting still works
});

test('stalled keeps running status and injects stalled', () => {
  const [j] = overlayJobs([rec({ state: 'stalled' })]);
  assert.equal(j.status, 'running');
  assert.ok(j.stalled);
});

test('stalled duration derives from updated_epoch', () => {
  const nowS = Date.now() / 1000;
  const [j] = overlayJobs([rec({
    state: 'stalled',
    extra: { native: { id: 'r566', label: 'render 566', status: 'running' }, updated_epoch: nowS - 120 },
  })]);
  assert.equal(j.status, 'running');
  assert.ok(j.stalled >= 119 && j.stalled <= 122);
});

// FINAL review, critical 1 (overlay half). `interrupted` is not a failure —
// no exit status was ever observed. Same rule as the in-chat rows.
test('interrupted is its own status, not failed', () => {
  const [j] = overlayJobs([rec({ state: 'interrupted' })]);
  assert.equal(j.status, 'interrupted');
});

test('interrupted never invents an error the registry did not report', () => {
  const [j] = overlayJobs([rec({ state: 'interrupted', error: '' })]);
  assert.ok(!j.error, 'no fabricated error text');
  assert.doesNotMatch(JSON.stringify(j), /backend restart/i);
  const [k] = overlayJobs([rec({
    state: 'interrupted',
    extra: { native: { id: 'r566', label: 'render 566', status: 'running', error: 'ffmpeg 137' } },
  })]);
  assert.equal(k.error, 'ffmpeg 137');
});

test('the interrupted overlay row renders neutral, honest copy', () => {
  const html = jobHtml({ id: 'r566', label: 'render 566', kind: 'render', status: 'interrupted' }, false);
  assert.match(html, /stopped · outcome unknown/);
  assert.match(html, /lj-job[^"]*\binterrupted\b/);
  assert.doesNotMatch(html, /\bfailed\b/);
});

test('non-job sources are excluded', () => {
  assert.deepEqual(overlayJobs([rec({ source: 'taskfile' })]), []);
});
