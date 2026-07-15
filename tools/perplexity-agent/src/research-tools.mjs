export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createResearchTools({ fetchImpl = globalThis.fetch, serpApiKey = process.env.SERPAPI_API_KEY || '' } = {}) {
  return {
    async web_fetch({ url }) {
      const rawUrl = String(url || '');
      const target = new URL(rawUrl);
      if (!/^https?:$/.test(target.protocol)) throw new Error('web_fetch only supports http/https URLs');
      const res = await fetchImpl(target.href, { headers: { 'user-agent': 'perplexity-agent/0.1' } });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const text = stripHtml(await res.text());
      return { url: rawUrl, text: text.slice(0, 12000) };
    },
    async web_search({ query, count = 5 }) {
      if (!serpApiKey) throw new Error('SerpAPI key required for web_search');
      const params = new URLSearchParams({
        engine: 'google',
        q: String(query || ''),
        num: String(Math.max(1, Math.min(Number(count) || 5, 10))),
        api_key: serpApiKey,
      });
      const res = await fetchImpl(`https://serpapi.com/search.json?${params.toString()}`);
      if (!res.ok) throw new Error(`search failed: ${res.status}`);
      const data = await res.json();
      return {
        results: (data.organic_results || []).filter((r) => r.link).slice(0, count).map((r) => ({
          title: r.title || r.link,
          url: r.link,
          snippet: r.snippet || '',
        })),
      };
    },
  };
}
