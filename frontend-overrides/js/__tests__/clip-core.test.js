import { test } from 'node:test';
import assert from 'node:assert';
import { isUrlOnlyDraft, clipChipHtml, clipErrorMessage } from '../redesign/clip-core.js';

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

test('clipErrorMessage: also covers bad_request and dns_failed (task-4 codes the brief sample omitted)', () => {
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
