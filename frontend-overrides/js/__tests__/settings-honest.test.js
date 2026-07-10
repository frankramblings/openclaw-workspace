import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';

const live = {
  modelGroups: [
    { ep: 'Claude CLI', endpointId: 'claude-cli', models: [{ id: 'claude-cli·claude-opus-4-8', mid: 'claude-opus-4-8', name: 'Opus 4.8', endpointId: 'claude-cli', ep: 'Claude CLI' }] },
    { ep: 'OpenAI', endpointId: 'openai', models: [{ id: 'openai·gpt-5.2', mid: 'gpt-5.2', name: 'GPT-5.2', endpointId: 'openai', ep: 'OpenAI' }] },
  ],
  modelList: [
    { id: 'claude-cli·claude-opus-4-8', mid: 'claude-opus-4-8', name: 'Opus 4.8', endpointId: 'claude-cli', ep: 'Claude CLI' },
    { id: 'openai·gpt-5.2', mid: 'gpt-5.2', name: 'GPT-5.2', endpointId: 'openai', ep: 'OpenAI' },
  ],
  defaultModel: 'claude-cli·claude-opus-4-8',
};
const st = (setSection, l = live) => ({ surface: 'settings', setSection, ui: {}, accent: '#4fe3d1', live: l });

test('models section renders the REAL gateway endpoints, not the fabricated ones', () => {
  const html = renderCenter(st('services'));
  assert.match(html, /Claude CLI/);
  assert.match(html, /Opus 4\.8/);
  assert.doesNotMatch(html, /llama3\.1|qwen2\.5|DeepSeek|deepseek-chat/);
});

test('models section without live data shows an honest empty note', () => {
  const html = renderCenter(st('services', {}));
  assert.match(html, /set-live-empty/);
  assert.doesNotMatch(html, /llama3\.1|DeepSeek/);
});

test('fake add-endpoint form is gone from the models section', () => {
  const html = renderCenter(st('services'));
  assert.doesNotMatch(html, /Scan for Servers/);
  assert.doesNotMatch(html, /sk-…/);
});

test('AI defaults shows the real default model', () => {
  const html = renderCenter(st('ai'));
  assert.match(html, /Opus 4\.8/);
  assert.doesNotMatch(html, />claude-opus-4</);
  assert.doesNotMatch(html, /qwen2\.5:7b/);
});

test('email section has no Writing Style mock (feature declined — Gary already knows Frank)', () => {
  const html = renderCenter(st('email'));
  assert.doesNotMatch(html, /Writing Style/);
  assert.doesNotMatch(html, /Extract from Sent/);
  assert.doesNotMatch(html, /I keep emails short and direct/);
});

test('settings buttons without an action render disabled, never fake-clickable', () => {
  for (const sec of ['ai', 'integrations', 'email', 'reminders', 'account']) {
    const html = renderCenter(st(sec));
    for (const btn of html.matchAll(/<button[^>]*class="set-btn[^"]*"[^>]*>/g)) {
      if (!btn[0].includes('data-act=')) {
        assert.match(btn[0], /disabled/, `dead button in ${sec} must be disabled: ${btn[0]}`);
      }
    }
  }
});
