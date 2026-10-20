// First-run hints ("Add to Home Screen", "all your threads live here") are for
// someone using a mobile BROWSER. The GaryNative WKWebView shell is already an
// installed app, and (until the data-store wipe was removed) it also lost the
// "dismissed" flag every launch, so both cards popped up on almost every
// launch. In the native shell neither may ever appear.
import { test, mock } from 'node:test';
import assert from 'node:assert';

async function loadJsdom() {
  for (const spec of ['jsdom', '/home/frank/code/openclaw/node_modules/jsdom/lib/api.js']) {
    try { return (await import(spec)).JSDOM; } catch (_) { /* try next */ }
  }
  return null;
}
const JSDOM = await loadJsdom();
const t = JSDOM ? test : test.skip;

const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IOS_NATIVE = `${IOS_SAFARI} GaryNative`;

let installMod; let threadsMod; let dom;
if (JSDOM) {
  dom = new JSDOM('<!doctype html><body><div id="r"><button class="m-nav-btn" data-act="openConvSheet"></button></div></body>', { url: 'https://example.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  for (const k of ['window', 'document', 'localStorage', 'navigator']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  installMod = await import('../redesign/mobile/install-hint.js');
  threadsMod = await import('../redesign/mobile/threads-hint.js');
}

function setUA(ua) { Object.defineProperty(dom.window.navigator, 'userAgent', { value: ua, configurable: true }); }
function reset() {
  dom.window.localStorage.clear();
  for (const id of ['pwa-install-hint', 'threads-hint']) { const el = dom.window.document.getElementById(id); if (el) el.remove(); }
}

t('control: a mobile browser still gets the install hint', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    reset(); setUA(IOS_SAFARI);
    installMod.maybeShowInstallHint(() => true);
    mock.timers.tick(3000);
    assert.ok(dom.window.document.getElementById('pwa-install-hint'), 'browser users keep the hint');
  } finally { mock.timers.reset(); }
});

t('control: a mobile browser still gets the threads hint', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    reset(); setUA(IOS_SAFARI);
    threadsMod.maybeShowThreadsHint(() => true);
    mock.timers.tick(4000);
    assert.ok(dom.window.document.getElementById('threads-hint'), 'browser users keep the hint');
  } finally { mock.timers.reset(); }
});

t('the native shell never shows the install hint, even with empty storage', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    reset(); setUA(IOS_NATIVE);
    installMod.maybeShowInstallHint(() => true);
    mock.timers.tick(10000);
    assert.strictEqual(dom.window.document.getElementById('pwa-install-hint'), null);
  } finally { mock.timers.reset(); }
});

t('the native shell never shows the threads hint, even with empty storage', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    reset(); setUA(IOS_NATIVE);
    threadsMod.maybeShowThreadsHint(() => true);
    mock.timers.tick(10000);
    assert.strictEqual(dom.window.document.getElementById('threads-hint'), null);
  } finally { mock.timers.reset(); }
});
