import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';
import { mChat } from '../redesign/mobile/mobile-surfaces.js';
import { cardButtonsHtml } from '../redesign/live/inbox-logic.js';
import { esc } from '../redesign/dom.js';

test('desktop chat header shows no mock title/subtitle/model/usage before live data', () => {
  const html = renderCenter({ surface: 'chat', live: {} });
  assert.doesNotMatch(html, /Workspace Streaming Chat Updates/);
  assert.doesNotMatch(html, /12 messages · claude-opus-4/);
  assert.doesNotMatch(html, />opus-4</);
  assert.doesNotMatch(html, /4\.4%/);
});

test('mobile chat model chip shows a placeholder, not the mock id, before live data', () => {
  const html = mChat({ live: {} });
  assert.doesNotMatch(html, /opus-4/);
  assert.match(html, /m-model-name">…</);
});

test('inbox icon affordances use SVG/app glyphs, not colored emoji', () => {
  // A calendar invite renders all three icon affordances (open/snooze/gary).
  const invite = { id: '7', source: 'calendar', actions: [], meta: {} };
  const html = cardButtonsHtml(invite, esc, {});
  assert.doesNotMatch(html, /⏰|🤖/);
  assert.match(html, /<svg[^>]*><circle cx="12" cy="12" r="9"/); // clock
  assert.match(html, /✦/); // the app's AI glyph for the gary affordance
});

test('integrations section drops the fabricated account details', () => {
  const html = renderCenter({ surface: 'settings', setSection: 'integrations', ui: {}, accent: '#4fe3d1', live: {} });
  assert.doesNotMatch(html, /you@example\.com/);
  assert.doesNotMatch(html, /your-workspace\.slack\.com/);
});
