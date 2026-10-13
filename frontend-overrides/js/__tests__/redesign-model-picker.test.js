import { test } from 'node:test';
import assert from 'node:assert';
import { modelPopover } from '../redesign/surfaces.js';
import { providerKey, providerLogo } from '../redesign/provider-logo.js';

// claude-sonnet-4-6 is offered by BOTH endpoints — the identity-bug case.
const groups = [
  { ep: 'Claude CLI', endpointId: 'claude-cli', hasTag: false, tag: '', models: [
    { id: 'claude-cli·claude-opus-4-8', mid: 'claude-opus-4-8', name: 'Claude Opus 4.8', endpointId: 'claude-cli', ep: 'Claude CLI' },
    { id: 'claude-cli·claude-sonnet-4-6', mid: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', endpointId: 'claude-cli', ep: 'Claude CLI' },
  ] },
  { ep: 'Perplexity', endpointId: 'perplexity-web', hasTag: true, tag: 'chat only', models: [
    { id: 'perplexity-web·claude-sonnet-4-6', mid: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', endpointId: 'perplexity-web', ep: 'Perplexity' },
  ] },
];
const state = (over = {}) => ({
  live: {
    modelGroups: groups,
    defaultModel: 'claude-cli·claude-opus-4-8',
    chat: { model: 'claude-sonnet-4-6', endpointId: 'claude-cli' },
    ...over,
  },
});

test('loading state before the list arrives', () => {
  assert.match(modelPopover({ live: {} }), /model-pop[\s\S]*Loading…/);
});

test('one group header per endpoint, with the chat-only tag only on Perplexity', () => {
  const html = modelPopover(state());
  assert.match(html, /class="model-ep">Claude CLI</);
  assert.match(html, /class="model-ep">Perplexity</);
  assert.equal((html.match(/class="model-ep"/g) || []).length, 2);
  assert.match(html, /class="model-tag">chat only</);
  assert.equal((html.match(/class="model-tag"/g) || []).length, 1);
});

test('rows carry only the bare model name and the composite id', () => {
  const html = modelPopover(state());
  assert.match(html, /data-act="setModel" data-arg="claude-cli·claude-opus-4-8"/);
  assert.match(html, /data-act="setModel" data-arg="perplexity-web·claude-sonnet-4-6"/);
  assert.match(html, /class="model-name">Claude Sonnet 4.6</);
  assert.doesNotMatch(html, /via Perplexity/); // suffix stripped to bare name
});

test('identity fix: same model under two endpoints does NOT co-select', () => {
  const html = modelPopover(state()); // active = claude-cli·claude-sonnet-4-6
  // exactly one selected row and one check, on the Claude CLI sonnet
  assert.equal((html.match(/class="model-row sel"/g) || []).length, 1);
  assert.equal((html.match(/class="model-check"/g) || []).length, 1);
  assert.match(html, /class="model-row sel" data-act="setModel" data-arg="claude-cli·claude-sonnet-4-6"/);
  // the Perplexity copy of the same model is NOT selected
  assert.doesNotMatch(html, /class="model-row sel" data-act="setModel" data-arg="perplexity-web·claude-sonnet-4-6"/);
});

test('default star marks exactly one row (the composite default)', () => {
  const html = modelPopover(state());
  assert.equal((html.match(/mstar-def/g) || []).length, 1);
  assert.match(html, /class="mstar mstar-def" data-act="setDefaultModel" data-arg="claude-cli·claude-opus-4-8"/);
});

test('the popover wrapper swallows chrome clicks (data-act="noop")', () => {
  assert.match(modelPopover(state()), /class="model-pop" data-act="noop"/);
});

test('provider icon follows the endpoint before the underlying model family', () => {
  assert.equal(providerKey('claude-cli', 'claude-opus-4-8'), 'anthropic');
  assert.equal(providerKey('openai', 'gpt-5.5'), 'openai');
  assert.equal(providerKey('perplexity-web', 'claude-sonnet-4-6'), 'perplexity');
  assert.match(providerLogo('perplexity-web', 'claude-sonnet-4-6'), /<svg/);
});

test('local catalog models inherit their model-family logos', () => {
  const qwenDsh = providerLogo('dsh', 'qwen3.6-dsh');
  const qwenLocal = providerLogo('local', 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit');
  const glmLocal = providerLogo('local', 'mlx-community/GLM-4-9B-0414-4bit');

  assert.match(qwenDsh, /<svg/);
  assert.equal(qwenDsh, qwenLocal);
  assert.match(glmLocal, /<svg/);
  assert.notEqual(glmLocal, qwenLocal);
});

test('opening the mobile model sheet loads the shared model catalog', async () => {
  globalThis.location = { origin: 'http://localhost' };
  const [{ mobileActions }, { runtime }] = await Promise.all([
    import('../redesign/mobile/mobile-app.js'),
    import('../redesign/live/runtime.js'),
  ]);
  const s = { live: {}, mModelSheetOpen: false };
  let loaded = 0;
  const priorActions = runtime.actions;
  runtime.actions = { loadModelOptions: async () => { loaded += 1; } };
  try {
    await mobileActions(s).openModelSheet();
    assert.equal(s.mModelSheetOpen, true);
    assert.equal(loaded, 1);
  } finally {
    runtime.actions = priorActions;
  }
});

test('ornith models get the ornith logo, not qwen', () => {
  assert.equal(providerKey('', 'ornith-1.5-dsh'), 'ornith');
  assert.equal(providerKey('', 'ornith-ai/Ornith-1.5-35B-A3B-MLX-4bit'), 'ornith');
  assert.equal(providerKey('', 'qwen3.6-dsh'), 'qwen');
  assert.match(providerLogo('', 'ornith-1.5-dsh'), /^<svg[^>]+fill="currentColor"/);
  assert.doesNotMatch(providerLogo('', 'ornith-1.5-dsh'), /<img|data:image/);
  assert.doesNotMatch(providerLogo('', 'ornith-1.5-dsh'), /clipPath|url\(#/);
});

test('Ornith logo appears in the legacy session-list provider map and mobile model sheet rows', async () => {
  const { providerLogo: legacyLogo } = await import('../../../frontend/js/providers.js');
  assert.match(legacyLogo('ornith-1.5-dsh'), /^<svg[^>]+fill="currentColor"/);
  assert.doesNotMatch(legacyLogo('ornith-1.5-dsh'), /<img|clipPath|url\(#|id=/);
  assert.match(legacyLogo('qwen3.6-dsh'), /<svg/);
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../redesign/mobile/mobile-sheets.js', import.meta.url), 'utf8'));
  assert.match(src, /providerLogo\(m\.endpointId, m\.mid\)/);
});

test('conversation-row badges get the one-colour Ornith glyph, other providers unchanged', async () => {
  const { providerGlyph, providerLogo: logo } = await import('../redesign/provider-logo.js');
  assert.match(providerGlyph('', 'ornith-1.5-dsh'), /^<svg[^>]+fill="currentColor"/);
  assert.doesNotMatch(providerGlyph('', 'ornith-1.5-dsh'), /<img|clipPath|url\(#|id=/);
  assert.equal(providerGlyph('', 'qwen3.6-dsh'), logo('', 'qwen3.6-dsh'));
  const fs = await import('node:fs');
  for (const f of ['../redesign/surfaces.js', '../redesign/mobile/mobile-sheets.js']) {
    assert.match(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /const rowLogo = r\.term \? '' : \(providerGlyph\(/);
  }
});
