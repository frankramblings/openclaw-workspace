import { test } from 'node:test';
import assert from 'node:assert';
import { mChatMsg } from '../redesign/mobile/mobile-surfaces.js';

const baseState = { live: { chat: { mobileSheetMsgId: null, msgMenuOpen: null } } };
const asst = (extra = {}) => ({ id: 'a1', role: 'assistant', text: 'Hello', time: '10:00', ...extra });

// ── pending pill ─────────────────────────────────────────────────────────────

test('mChatMsg omits pending pill when pendingTokens is absent', () => {
  const html = mChatMsg(asst(), baseState);
  assert.doesNotMatch(html, /m-turn-pending-pill/);
});

test('mChatMsg omits pending pill when pendingTokens is empty array', () => {
  const html = mChatMsg(asst({ pendingTokens: [] }), baseState);
  assert.doesNotMatch(html, /m-turn-pending-pill/);
});

test('mChatMsg renders pending pill for a single pending token', () => {
  const html = mChatMsg(asst({
    pendingTokens: [{ id: 't1', kind: 'image', label: 'my prompt' }],
  }), baseState);
  assert.match(html, /m-turn-pending-pill/);
  assert.match(html, /m-turn-pending-spin[\s\S]*pending/);
});

test('mChatMsg renders count pill for multiple pending tokens', () => {
  const html = mChatMsg(asst({
    pendingTokens: [
      { id: 't1', kind: 'image', label: 'first' },
      { id: 't2', kind: 'image', label: 'second' },
    ],
  }), baseState);
  assert.match(html, /m-turn-pending-pill/);
  assert.match(html, /m-turn-pending-spin[\s\S]*>2</);
});

test('mChatMsg pending pill title lists token kinds and labels', () => {
  const html = mChatMsg(asst({
    pendingTokens: [{ id: 't1', kind: 'image', label: 'sun photo' }],
  }), baseState);
  assert.match(html, /title="image · sun photo"/);
});

// ── update blocks ────────────────────────────────────────────────────────────

test('mChatMsg omits update block section when updateBlocks is absent', () => {
  const html = mChatMsg(asst(), baseState);
  assert.doesNotMatch(html, /m-turn-update-block/);
});

test('mChatMsg omits update block section when updateBlocks is empty', () => {
  const html = mChatMsg(asst({ updateBlocks: [] }), baseState);
  assert.doesNotMatch(html, /m-turn-update-block/);
});

test('mChatMsg renders update block with header for image payload', () => {
  const html = mChatMsg(asst({
    updateBlocks: [{ elapsed_ms: 0, payload: { image_url: 'http://x.com/img.png', alt_text: 'a dog' } }],
  }), baseState);
  assert.match(html, /m-turn-update-block/);
  assert.match(html, /m-turn-update-header/);
  assert.match(html, /↳ update, just now/);
  assert.match(html, /m-turn-update-image/);
  assert.match(html, /http:\/\/x\.com\/img\.png/);
  assert.match(html, /alt="a dog"/);
});

test('mChatMsg renders update block with elapsed time in minutes', () => {
  const html = mChatMsg(asst({
    updateBlocks: [{ elapsed_ms: 90000, payload: { image_url: 'http://x.com/img.png' } }],
  }), baseState);
  assert.match(html, /↳ update, 2m later/);
});

test('mChatMsg renders update block with error class for error payload', () => {
  const html = mChatMsg(asst({
    updateBlocks: [{ elapsed_ms: 0, payload: { error: 'generation failed' } }],
  }), baseState);
  assert.match(html, /m-turn-update-block/);
  assert.match(html, /m-turn-update-error/);
  assert.match(html, /generation failed/);
});

test('mChatMsg escapes XSS in update error payload', () => {
  const html = mChatMsg(asst({
    updateBlocks: [{ elapsed_ms: 0, payload: { error: '<script>bad</script>' } }],
  }), baseState);
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('mChatMsg renders multiple update blocks in order', () => {
  const html = mChatMsg(asst({
    updateBlocks: [
      { elapsed_ms: 0, payload: { image_url: 'http://a.com/1.png' } },
      { elapsed_ms: 120000, payload: { image_url: 'http://a.com/2.png' } },
    ],
  }), baseState);
  const first = html.indexOf('1.png');
  const second = html.indexOf('2.png');
  assert.ok(first < second, 'update blocks appear in insertion order');
  assert.match(html, /↳ update, 2m later/);
});
