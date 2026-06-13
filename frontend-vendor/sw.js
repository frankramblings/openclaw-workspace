// static/sw.js — Odysseus PWA Service Worker
// Strategy:
//   - HTML (navigation): stale-while-revalidate. Instant open from cache,
//     background refresh so the next open has latest HTML.
//   - JS/CSS (/static/*.js|.css): network-first, cache fallback for offline.
//     (So code/style edits show up on a normal reload, no manual cache clear.)
//   - Other static assets (images/fonts/libs): cache-first with bg refresh.
//   - API / non-GET: never cached.
// Bump CACHE_NAME whenever the precache list or SW logic changes.
const CACHE_NAME = 'gary-v327';

// Generated at deploy time by scripts/sync-frontend.sh from the files
// actually present in frontend/ (the hand-maintained list rotted: it missed
// the whole workspace overlay layer and still listed removed files).
const PRECACHE = [
  '/',
  /*__PRECACHE__*/
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // addAll is atomic — if any item fails, none are cached. Use individual
      // puts so a single 404 can't block the whole install.
      Promise.all(
        PRECACHE.map(url =>
          fetch(url, { cache: 'reload' })
            .then(res => res.ok ? cache.put(url, res) : null)
            .catch(() => null)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Force the network WITH revalidation, plus a timeout. `cache:'no-cache'` makes
// a conditional request (304 when unchanged — cheap), so a stale HTTP-cache
// entry can never be served silently; the SW cache is the OFFLINE fallback
// only. The timeout means a dead/half-open link falls back to cache instead of
// hanging for the full OS TCP timeout.
function freshFetch(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sw-timeout')), ms || 4500);
    fetch(req, { cache: 'no-cache' }).then(
      res => { clearTimeout(t); resolve(res); },
      err => { clearTimeout(t); reject(err); }
    );
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never touch API calls or non-GET.
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;

  // App shell — the SPA root HTML + all JS/CSS: NETWORK-FIRST with revalidation
  // so an edit always lands on the next online reopen (no more "fully close /
  // re-add the PWA" dance). Cache is the offline fallback only. (HTML was
  // stale-while-revalidate, which left the shell one reopen behind; JS/CSS was
  // plain network-first, which the HTTP cache could still answer with a stale
  // copy.) Non-root navigations (deep-linked /static/*.html) fall through.
  const isNav  = e.request.mode === 'navigate' && url.pathname === '/';
  const isCode = url.pathname.startsWith('/static/') &&
                 /\.(js|css)(\?|$)/.test(url.pathname + url.search);
  if (isNav || isCode) {
    const cacheKey = isNav ? '/' : e.request;
    // For navigation use a URL string, not the navigate-mode Request (which
    // can't carry a custom cache mode); JS/CSS pass their Request through.
    const netReq = isNav ? url.href : e.request;
    e.respondWith(
      freshFetch(netReq).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
        }
        return res;
      }).catch(() => caches.match(cacheKey).then(c => c || (isNav ? caches.match('/') : undefined)))
    );
    return;
  }

  // Other static assets (images, fonts, libs): cache-first with background
  // refresh — content-stable and heavy, so instant-from-cache is right here.
  if (url.pathname.startsWith('/static/')) {
    e.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(e.request);
        const fetching = fetch(e.request).then(res => {
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || fetching;
      })
    );
    return;
  }
});
