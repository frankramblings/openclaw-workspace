import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchTools, discoverSerpApiKey, stripHtml } from '../src/research-tools.mjs';

test('stripHtml removes scripts, tags, and repeated whitespace', () => {
  assert.equal(stripHtml('<html><script>bad()</script><body><h1>Title</h1><p>Hello   world</p></body></html>'), 'Title Hello world');
});

test('web_fetch returns bounded readable text', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/html']]),
    async text() { return '<h1>Example</h1><p>Body text</p>'; },
  });
  const tools = createResearchTools({ fetchImpl, serpApiKey: 'unused' });
  const out = await tools.web_fetch({ url: 'https://example.com' });
  assert.equal(out.url, 'https://example.com');
  assert.match(out.text, /Example Body text/);
});

test('web_search maps SerpAPI organic results', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /serpapi\.com/);
    return {
      ok: true,
      status: 200,
      async json() {
        return { organic_results: [{ title: 'One', link: 'https://one.test', snippet: 'Snippet' }] };
      },
    };
  };
  const tools = createResearchTools({ fetchImpl, serpApiKey: 'key' });
  const out = await tools.web_search({ query: 'test' });
  assert.deepEqual(out.results, [{ title: 'One', url: 'https://one.test', snippet: 'Snippet' }]);
});

test('web_search requires a key', async () => {
  const tools = createResearchTools({ fetchImpl: async () => null, serpApiKey: '' });
  await assert.rejects(() => tools.web_search({ query: 'test' }), /SerpAPI key/);
});

test('discoverSerpApiKey prefers env, then workspace settings, then OpenClaw config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pplx-agent-search-'));
  try {
    const settingsPath = join(dir, 'settings.json');
    const configPath = join(dir, 'openclaw.json');
    await writeFile(settingsPath, JSON.stringify({ serpapi_api_key: 'settings-key' }));
    await writeFile(configPath, JSON.stringify({ skills: { entries: { serpapi: { apiKey: 'config-key' } } } }));
    assert.equal(discoverSerpApiKey({
      env: { SERPAPI_API_KEY: 'env-key' },
      settingsPath,
      openclawConfigPath: configPath,
    }), 'env-key');
    assert.equal(discoverSerpApiKey({
      env: {},
      settingsPath,
      openclawConfigPath: configPath,
    }), 'settings-key');
    await writeFile(settingsPath, JSON.stringify({}));
    assert.equal(discoverSerpApiKey({
      env: {},
      settingsPath,
      openclawConfigPath: configPath,
    }), 'config-key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
