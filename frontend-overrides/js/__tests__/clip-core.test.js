import { test } from 'node:test';
import assert from 'node:assert';
import { isUrlOnlyDraft, clipChipHtml, clipErrorMessage, clipResultVerb, syncClipChip } from '../redesign/clip-core.js';

// ---- isUrlOnlyDraft -------------------------------------------------------

test('isUrlOnlyDraft: a bare https URL is URL-only', () => {
  assert.equal(isUrlOnlyDraft('https://example.com/article'), true);
});

test('isUrlOnlyDraft: a bare http URL is URL-only', () => {
  assert.equal(isUrlOnlyDraft('http://example.com'), true);
});

test('isUrlOnlyDraft: surrounding whitespace is trimmed first', () => {
  assert.equal(isUrlOnlyDraft('  https://example.com/x  \n'), true);
});

test('isUrlOnlyDraft: prose plus a URL is not URL-only', () => {
  assert.equal(isUrlOnlyDraft('check this out https://example.com/x'), false);
});

test('isUrlOnlyDraft: two URLs is not URL-only', () => {
  assert.equal(isUrlOnlyDraft('https://a.com https://b.com'), false);
});

test('isUrlOnlyDraft: schemeless host is not URL-only (matches clip_guard.check_url)', () => {
  assert.equal(isUrlOnlyDraft('example.com/x'), false);
});

test('isUrlOnlyDraft: non-http(s) scheme is not URL-only', () => {
  assert.equal(isUrlOnlyDraft('ftp://example.com/x'), false);
});

test('isUrlOnlyDraft: empty, whitespace-only, or missing draft is not URL-only', () => {
  assert.equal(isUrlOnlyDraft(''), false);
  assert.equal(isUrlOnlyDraft('   '), false);
  assert.equal(isUrlOnlyDraft(undefined), false);
  assert.equal(isUrlOnlyDraft(null), false);
});

// ---- clipChipHtml ----------------------------------------------------------

test('clipChipHtml: carries the URL in data-arg and is clickable via data-act', () => {
  const html = clipChipHtml('https://example.com/a-b');
  assert.match(html, /data-act="clipDraftUrl"/);
  assert.match(html, /data-arg="https:\/\/example\.com\/a-b"/);
});

test('clipChipHtml: escapes an untrusted URL for the attribute', () => {
  const html = clipChipHtml('https://example.com/"><script>x</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&quot;'));
});

test('clipChipHtml: no em dashes in the chip copy', () => {
  assert.ok(!clipChipHtml('https://example.com').includes('—'));
});

// ---- clipErrorMessage -------------------------------------------------------

test('clipErrorMessage: maps every backend/clip.py error code to a sentence', () => {
  for (const code of ['bad_url', 'blocked_host', 'fetch_failed', 'too_large',
                      'unsupported_type', 'extract_failed', 'write_failed']) {
    const msg = clipErrorMessage({ body: { ok: false, error: code, detail: 'x' } });
    assert.ok(msg && msg.length > 0);
    assert.ok(!msg.includes('—'));
  }
});

test('clipErrorMessage: also covers bad_request and the forward-compatible dns_failed', () => {
  for (const code of ['bad_request', 'dns_failed']) {
    const msg = clipErrorMessage({ body: { ok: false, error: code, detail: 'x' } });
    assert.ok(msg && msg.length > 0);
    assert.ok(!msg.includes('—'));
  }
});

test('clipErrorMessage: unknown code or a non-ApiError falls back to a generic message', () => {
  assert.equal(typeof clipErrorMessage({ body: { error: 'something_new' } }), 'string');
  assert.equal(typeof clipErrorMessage(new Error('network down')), 'string');
  assert.equal(typeof clipErrorMessage(undefined), 'string');
});

// ---- clipResultVerb (fix round 1) ------------------------------------------

test('clipResultVerb: a brand-new document (version_count 1, or missing) is "Clipped"', () => {
  assert.equal(clipResultVerb({ version_count: 1 }), 'Clipped');
  assert.equal(clipResultVerb({}), 'Clipped');
  assert.equal(clipResultVerb(null), 'Clipped');
  assert.equal(clipResultVerb(undefined), 'Clipped');
});

test('clipResultVerb: a re-clip (version_count > 1) is "Updated"', () => {
  assert.equal(clipResultVerb({ version_count: 2 }), 'Updated');
  assert.equal(clipResultVerb({ version_count: 7 }), 'Updated');
});

// ---- syncClipChip (fix round 1) --------------------------------------------
//
// syncClipChip never reads the global document/window -- it only calls
// standard node methods on the `ta` argument it's handed -- so a small
// hand-rolled fake composer is enough; no browser shim needed.

function fakeComposer() {
  let chip = null; // { _arg, getAttribute, remove } | null
  const calls = { insert: 0, remove: 0 };
  const wrap = { querySelector: (sel) => (sel === '.clip-chip' ? chip : null) };
  const ta = {
    closest: (sel) => (sel.includes('composer') ? wrap : null),
    insertAdjacentHTML: (pos, html) => {
      calls.insert++;
      const m = html.match(/data-arg="([^"]*)"/);
      chip = {
        _arg: m ? m[1] : '',
        getAttribute(name) { return name === 'data-arg' ? this._arg : null; },
        remove() { calls.remove++; chip = null; },
      };
    },
  };
  return { ta, calls, getChip: () => chip };
}

test('syncClipChip: inserts a chip once the draft is a bare URL', () => {
  const { ta, calls, getChip } = fakeComposer();
  syncClipChip(ta, 'https://example.com/a');
  assert.equal(calls.insert, 1);
  assert.equal(calls.remove, 0);
  assert.equal(getChip().getAttribute('data-arg'), 'https://example.com/a');
});

test('syncClipChip: removes the chip once the draft is no longer a bare URL', () => {
  const { ta, calls, getChip } = fakeComposer();
  syncClipChip(ta, 'https://example.com/a');
  assert.equal(calls.insert, 1);
  syncClipChip(ta, 'https://example.com/a plus some more text');
  assert.equal(calls.remove, 1);
  assert.equal(getChip(), null);
});

test('syncClipChip: a no-op draft never removes an absent chip', () => {
  const { ta, calls } = fakeComposer();
  syncClipChip(ta, 'just typing a message, no url here');
  assert.equal(calls.insert, 0);
  assert.equal(calls.remove, 0);
});

test('syncClipChip: idempotent -- calling again with the SAME url touches the DOM zero times', () => {
  const { ta, calls } = fakeComposer();
  syncClipChip(ta, 'https://example.com/a');
  assert.equal(calls.insert, 1);
  syncClipChip(ta, 'https://example.com/a');
  syncClipChip(ta, 'https://example.com/a');
  assert.equal(calls.insert, 1, 'no re-insert for an unchanged URL');
  assert.equal(calls.remove, 0, 'no removal for an unchanged URL');
});

test('syncClipChip: a DIFFERENT url replaces the chip (remove then insert)', () => {
  const { ta, calls, getChip } = fakeComposer();
  syncClipChip(ta, 'https://example.com/a');
  syncClipChip(ta, 'https://example.com/b');
  assert.equal(calls.insert, 2);
  assert.equal(calls.remove, 1);
  assert.equal(getChip().getAttribute('data-arg'), 'https://example.com/b');
});

test('syncClipChip: no composer wrapper found is a no-op, never throws', () => {
  const ta = { closest: () => null };
  assert.doesNotThrow(() => syncClipChip(ta, 'https://example.com/a'));
});
