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
