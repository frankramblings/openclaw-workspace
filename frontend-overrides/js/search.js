// static/js/search.js
// WORKSPACE OVERRIDE (full file — tiny; re-merge if upstream changes).
// Adds the serpapi provider label and defaults to it (the workspace backend
// searches via SerpAPI server-side; key lives in OpenClaw's config).

/**
 * Search settings management — reads active provider from admin settings.
 */

let API_BASE = '';
let _provider = 'serpapi';
let _loaded = false;

export function init(apiBase) {
  API_BASE = apiBase;
  // Fetch provider on init so it's ready when chat needs it
  _fetchProvider();
}

async function _fetchProvider() {
  try {
    const res = await fetch((API_BASE || '') + '/api/auth/settings', { credentials: 'same-origin' });
    const s = await res.json();
    _provider = s.search_provider || 'serpapi';
    _loaded = true;
  } catch (e) { /* keep default */ }
}

export function getCurrentProvider() {
  return _provider;
}

const _labels = {
  serpapi: 'SerpAPI',
  searxng: 'SearXNG', brave: 'Brave', duckduckgo: 'DuckDuckGo',
  google_pse: 'Google', tavily: 'Tavily', serper: 'Serper',
  disabled: 'search (disabled)',
};

export function getProviderLabel() {
  return _labels[_provider] || _provider;
}

/** Re-fetch after admin saves new settings */
export function refresh() {
  _fetchProvider();
}

const searchModule = {
  init,
  getCurrentProvider,
  getProviderLabel,
  refresh
};

export default searchModule;
