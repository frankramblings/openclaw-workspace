// Rider A: mToastHtml (the shared "Refresh failed — showing cached data"
// notice) already rendered inline in mInbox/mEmailList/mCalendar, but pushed
// "More" sub-screens (Notes/Library/Research/Settings) go through
// mobile-app.js's pushedSurface() wrapper, which never carried it — so a
// background refresh failure on those four surfaces was silently invisible
// on mobile even though the SAME failure shows a toast on desktop
// (app.js renders inboxToastHtml unconditionally around every surface).
import { test } from 'node:test';
import assert from 'node:assert';
import { mToastHtml } from '../redesign/mobile/mobile-surfaces.js';

// mobile-app.js imports apiJson from live/api.js, which reads
// location.origin at module scope — same minimal shim other suites use
// (e.g. load-orchestration.test.js) to import a browser-shell module under
// plain Node. Dynamic import (not a static one) so the stub lands first.
globalThis.location = { origin: 'http://localhost' };
const { renderMobile } = await import('../redesign/mobile/mobile-app.js');

const toastState = { msg: 'Refresh failed — showing cached data', undoTs: null };

// Minimal state each pushed desktop renderer needs to not throw on unrelated
// missing fields (mirrors load-error-honest.test.js's per-surface fixtures —
// researchSurface in particular reads s.resCfg.rounds unconditionally).
const subState = {
  notes: {},
  library: {},
  research: { researchQuery: '', research: 'idle', resOpenCtl: null, resCfg: { rounds: 'Auto', engine: 'Default', endpoint: 'Claude-Cli', model: 'opus-4' } },
  settings: {},
};

for (const sub of ['notes', 'library', 'research', 'settings']) {
  test(`pushed "${sub}" surface shows the refresh-failure toast`, () => {
    const html = renderMobile({
      mTab: 'more', mSub: sub, inboxToast: toastState, live: {}, dismissed: [], ...subState[sub],
    });
    assert.match(html, /Refresh failed — showing cached data/);
  });
}

test('no toast state → pushed surfaces render no toast markup', () => {
  const html = renderMobile({ mTab: 'more', mSub: 'notes', live: {}, dismissed: [] });
  assert.doesNotMatch(html, /Refresh failed/);
});

test('mToastHtml is exported (pushedSurface reuses the same shared renderer as mInbox/mEmailList/mCalendar)', () => {
  assert.strictEqual(typeof mToastHtml, 'function');
  assert.match(mToastHtml({ inboxToast: toastState }), /inbox-toast/);
  assert.strictEqual(mToastHtml({ inboxToast: null }), '');
});

// ---------------------------------------------------------------------------
// Task 6.1: pull-to-refresh on the pushed More surfaces. wireMobileGestures'
// touchstart handler (mobile-app.js) resolves the pullable feed via
// `closest('[data-ptr]')` — pushedSurface's `.m-pushed` wrapper must carry
// that attribute (mobile.css already makes it the scroll container:
// flex:1;overflow:auto) or a downward pull on Notes/Library/Research/
// Settings silently does nothing, unlike every other mobile list.
// ---------------------------------------------------------------------------
for (const sub of ['notes', 'library', 'research', 'settings']) {
  test(`pushed "${sub}" surface's scroll container is pull-to-refreshable`, () => {
    const html = renderMobile({
      mTab: 'more', mSub: sub, live: {}, dismissed: [], ...subState[sub],
    });
    assert.match(html, /<div class="m-pushed" data-ptr="1">/);
  });
}

test('pushed surface shows the pull-to-refresh spinner while state.refreshing is set', () => {
  const html = renderMobile({
    mTab: 'more', mSub: 'notes', live: {}, dismissed: [], refreshing: true, ...subState.notes,
  });
  assert.match(html, /m-ptr open/);
});
