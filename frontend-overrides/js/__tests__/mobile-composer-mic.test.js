// Task 3.3: the composer's mic button had no data-act and no recorder behind
// it — a dead affordance that looked tappable but did nothing. Removed
// outright rather than wired up (no voice-capture feature exists).
import { test } from 'node:test';
import assert from 'node:assert';
import { mChat } from '../redesign/mobile/mobile-surfaces.js';

const state = { live: { chat: { thread: [] } }, draft: '' };

test('mobile composer renders no mic button', () => {
  const html = mChat(state);
  // Fingerprint the mic glyph's own path data — a unique enough signature
  // that a false negative (some unrelated icon reusing the class) can't slip by.
  assert.doesNotMatch(html, /M5 11a7 7 0 0 0 14 0M12 18v3/);
});

test('mobile composer bar has no bare (data-act-less) round button left behind', () => {
  const html = mChat(state);
  assert.doesNotMatch(html, /<button class="m-round-btn m-hide-kb">/);
});
