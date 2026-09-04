// CSP enforcement guard for the standalone static pages.
//
// backend/security_headers.py serves `script-src 'self'` (Report-Only today,
// enforcing under WORKSPACE_CSP_ENFORCE=1). That blocks inline <script>
// blocks, inline on<event>= attributes, and it blocks remote images through
// `img-src 'self' data: blob:`. login.html, newtab.html and landing.html were
// cleaned for that flip; this file keeps them clean.
//
// index-classic.html is deliberately NOT covered: it still carries seven
// inline blocks plus a jsdelivr KaTeX load and is pending a retirement
// decision, so asserting on it would fail by design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGES = ['login.html', 'newtab.html', 'landing.html'];

function read(page) {
  return readFileSync(join(OVERRIDES, page), 'utf8');
}

for (const page of PAGES) {
  test(`${page}: every <script> has a src (no inline blocks)`, () => {
    const html = read(page);
    const tags = html.match(/<script\b[^>]*>/gi) || [];
    const inline = tags.filter((t) => !/\bsrc\s*=/i.test(t));
    assert.deepEqual(inline, [], `inline <script> in ${page}: ${inline.join(', ')}`);
  });

  test(`${page}: no inline on<event>= handler attributes`, () => {
    const html = read(page);
    const handlers = html.match(/\son[a-z]+\s*=\s*["']/gi) || [];
    assert.deepEqual(handlers, [], `inline handlers in ${page}: ${handlers.join(', ')}`);
  });

  test(`${page}: no {{CSP_NONCE}} placeholder left behind`, () => {
    assert.ok(!read(page).includes('CSP_NONCE'), `${page} still carries CSP_NONCE`);
  });

  test(`${page}: no remote image sources`, () => {
    const html = read(page);
    const remote = [];
    const re = /<(?:img|source)\b[^>]*\b(?:src|srcset|poster)\s*=\s*"([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (/^https?:\/\//i.test(m[1].trim())) remote.push(m[1]);
    }
    assert.deepEqual(remote, [], `remote images in ${page}: ${remote.join(', ')}`);
  });

  test(`${page}: every referenced js/pages/*.js file exists`, () => {
    const html = read(page);
    const re = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi;
    const refs = [];
    let m;
    while ((m = re.exec(html)) !== null) refs.push(m[1]);
    const pageRefs = refs.filter((r) => r.includes('js/pages/'));
    assert.ok(pageRefs.length > 0, `${page} references no js/pages/ script`);
    for (const ref of pageRefs) {
      const rel = ref.replace(/^\/static\//, '').replace(/^\.?\//, '').split('?')[0];
      assert.ok(existsSync(join(OVERRIDES, rel)), `missing ${rel} referenced by ${page}`);
    }
  });
}

test('extracted page scripts are non-empty', () => {
  for (const f of ['login-theme-boot.js', 'login.js', 'login-bg.js', 'newtab.js', 'landing.js']) {
    const p = join(OVERRIDES, 'js', 'pages', f);
    assert.ok(existsSync(p), `missing js/pages/${f}`);
    assert.ok(readFileSync(p, 'utf8').trim().length > 100, `js/pages/${f} looks empty`);
  }
});
