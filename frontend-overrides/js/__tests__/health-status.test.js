// Task 2.2: kill fake health copy. deriveHealth() is the pure decision table —
// offline always wins, then the task-feed's connection tri-state decides
// online vs reconnecting. currentHealth()/healthDotColor() wrap it against the
// real navigator.onLine + task-feed signals for render-time callers.
import { test } from 'node:test';
import assert from 'node:assert';
import { deriveHealth, healthDotColor, currentHealth } from '../redesign/live/health.js';
import { connectionState } from '../redesign/live/task-feed.js';
import { mChat, mMore } from '../redesign/mobile/mobile-surfaces.js';

test('offline wins regardless of feed state', () => {
  assert.equal(deriveHealth({ online: false, feedState: 'connected' }), 'offline');
  assert.equal(deriveHealth({ online: false, feedState: 'reconnecting' }), 'offline');
  assert.equal(deriveHealth({ online: false, feedState: 'idle' }), 'offline');
});

test('online + a reconnecting feed reads "reconnecting…"', () => {
  assert.equal(deriveHealth({ online: true, feedState: 'reconnecting' }), 'reconnecting…');
});

test('online + a connected (or not-yet-booted) feed reads "online"', () => {
  assert.equal(deriveHealth({ online: true, feedState: 'connected' }), 'online');
  assert.equal(deriveHealth({ online: true, feedState: 'idle' }), 'online');
});

test('healthDotColor maps each status to a distinct color token', () => {
  assert.equal(healthDotColor('online'), 'var(--green)');
  assert.equal(healthDotColor('reconnecting…'), 'var(--amber)');
  assert.equal(healthDotColor('offline'), 'var(--red)');
});

test('healthDotColor falls back sanely for an unknown status', () => {
  assert.equal(healthDotColor('bogus'), 'var(--red)');
});

test('task-feed connectionState reports "idle" before subscribeTasks() ever boots (node:test has no EventSource)', () => {
  assert.equal(connectionState(), 'idle');
});

test('currentHealth() reads "online" under node:test (no navigator.onLine === false, no booted stream)', () => {
  assert.equal(currentHealth(), 'online');
});

// ---------------------------------------------------------------------------
// Render-level integration: the mobile chat header + More "Gary" card used to
// hardcode "online" / "online · gateway healthy" no matter what. Flipping the
// real navigator.onLine signal must move the rendered copy — proof it's
// actually wired to currentHealth(), not just coincidentally saying "online".
// ---------------------------------------------------------------------------
test('mobile chat header reflects real health — online by default, offline when navigator.onLine is false', () => {
  navigator.onLine = true;
  try {
    const htmlOnline = mChat({ live: {}, draft: '' });
    assert.match(htmlOnline, /m-conv-sub/);
    assert.match(htmlOnline, /__AGENT_NAME__ · online/);

    navigator.onLine = false;
    const htmlOffline = mChat({ live: {}, draft: '' });
    assert.match(htmlOffline, /__AGENT_NAME__ · offline/);
    assert.match(htmlOffline, /var\(--red\)/);
  } finally {
    navigator.onLine = true; // don't leak state into other test files
  }
});

test('mobile More hub Gary card drops the fabricated "gateway healthy" claim and reflects real health', () => {
  navigator.onLine = true;
  try {
    const htmlOnline = mMore({ live: {} });
    assert.doesNotMatch(htmlOnline, /gateway healthy/);
    assert.match(htmlOnline, /var\(--green\)/);

    navigator.onLine = false;
    const htmlOffline = mMore({ live: {} });
    assert.match(htmlOffline, /offline/);
    assert.match(htmlOffline, /var\(--red\)/);
  } finally {
    navigator.onLine = true;
  }
});
