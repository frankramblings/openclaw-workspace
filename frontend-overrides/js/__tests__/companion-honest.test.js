import { test } from 'node:test';
import assert from 'node:assert';
import { renderCompanion, renderReveal } from '../redesign/companion.js';

// Wave 5 (5.7f): the companion's __AGENT_NAME__ tab on non-chat surfaces used
// to show hardcoded mock content — a fake per-surface status line ("Three
// Cannes agreements are live…", "24 artifacts saved…" — see data.js's former
// DOCK export), two dead chips that dispatched no action, and an
// "Ask __AGENT_NAME__…" box with no send wiring at all. None of it was real:
// no surface here has a live per-page assistant backing it, so it's replaced
// with an honest quiet state that links to the one place that IS real: chat.
const gary = (surface) => ({ surface, compTab: 'gary', compSplit: false, fsOpen: {} });

test('the __AGENT_NAME__ pane on a non-chat surface has no fabricated status content', () => {
  for (const surface of ['email', 'inbox', 'calendar', 'research', 'library', 'notes']) {
    const html = renderCompanion(gary(surface));
    assert.doesNotMatch(html, /Three Cannes agreements/);
    assert.doesNotMatch(html, /24 artifacts saved/);
    assert.doesNotMatch(html, /triage assistant/);
    assert.doesNotMatch(html, /librarian/);
  }
});

test('the dead "Ask __AGENT_NAME__…" box and its chips are gone', () => {
  const html = renderCompanion(gary('email'));
  assert.doesNotMatch(html, /gary-ask/);
  assert.doesNotMatch(html, /Ask __AGENT_NAME__/);
  assert.doesNotMatch(html, /gary-chips/);
});

test('the quiet state links to chat with a real, wired action', () => {
  const html = renderCompanion(gary('email'));
  assert.match(html, /data-act="go" data-arg="chat"/);
});

test('the gicon/reveal avatar images are eager + sync-decoded (no teal-flash on re-render)', () => {
  const html = renderCompanion(gary('email'));
  assert.match(html, /class="gicon"><img[^>]*decoding="sync"[^>]*loading="eager"/);
  const revealHtml = renderReveal({ surface: 'email' });
  assert.match(revealHtml, /class="reveal-gicon"><img[^>]*decoding="sync"[^>]*loading="eager"/);
});
