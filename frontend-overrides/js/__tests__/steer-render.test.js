import { test } from 'node:test';
import assert from 'node:assert';
import { steerComposerHints, steerCaptionHtml } from '../redesign/steer-view.js';

test('busy + steer mode → Steer label and the queue chip', () => {
  const s = { live: { chat: { steerMode: true, busySessionId: 's1', activeId: 's1' } } };
  assert.deepEqual(steerComposerHints(s), { steerLabel: true, showQueueChip: true });
});

test('busy without steer mode → normal Send, no chip', () => {
  const s = { live: { chat: { steerMode: false, busySessionId: 's1', activeId: 's1' } } };
  assert.deepEqual(steerComposerHints(s), { steerLabel: false, showQueueChip: false });
});

test('idle → normal Send, no chip even if steerMode is stale', () => {
  const s = { live: { chat: { steerMode: true, busySessionId: null, activeId: 's1' } } };
  assert.deepEqual(steerComposerHints(s), { steerLabel: false, showQueueChip: false });
});

test('busy in another thread → viewed thread is not the busy one, no hints', () => {
  const s = { live: { chat: { steerMode: true, busySessionId: 's1', activeId: 's2' } } };
  assert.deepEqual(steerComposerHints(s), { steerLabel: false, showQueueChip: false });
});

test('caption only for steer bubbles, escaped and em-dash free', () => {
  assert.equal(steerCaptionHtml({ role: 'user' }), '');
  const html = steerCaptionHtml({ role: 'user', steer: true });
  assert.ok(html.includes('msg-steer-cap'));
  assert.ok(html.includes('Steered into the running turn'));
  assert.ok(!html.includes('—'));
});

test('steerNotice renders under the caption, escaped', () => {
  assert.ok(!steerCaptionHtml({ role: 'user', steer: true }).includes('msg-steer-notice'));
  const html = steerCaptionHtml({ role: 'user', steer: true, steerNotice: 'Gary <b>finished</b>' });
  assert.ok(html.indexOf('msg-steer-cap') < html.indexOf('msg-steer-notice'));
  assert.ok(html.includes('Gary &lt;b&gt;finished&lt;/b&gt;'));
  assert.ok(!html.includes('—'));
  // A notice without the steer flag renders nothing at all.
  assert.equal(steerCaptionHtml({ role: 'user', steerNotice: 'x' }), '');
});
