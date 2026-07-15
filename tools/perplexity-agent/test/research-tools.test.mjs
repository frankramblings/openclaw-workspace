import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResearchTools, stripHtml } from '../src/research-tools.mjs';

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
