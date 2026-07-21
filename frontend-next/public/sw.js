// /next service worker: online loads are always network-first, while the last
// complete hashed shell remains available offline. API requests are never cached.
const CACHE = 'workspace-next-v1'
const SHELL = '/next/'

async function fetchFresh(request, timeout = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try { return await fetch(request, { cache: 'no-cache', signal: controller.signal }) }
  finally { clearTimeout(timer) }
}

async function cacheShell() {
  const response = await fetchFresh(SHELL)
  if (!response.ok) return
  const html = await response.clone().text()
  const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => new URL(match[1], self.location.origin).pathname).filter(path => path.startsWith('/next/assets/'))
  const cache = await caches.open(CACHE)
  await cache.put(SHELL, response)
  await Promise.all(assets.map(async path => { try { const asset = await fetchFresh(path); if (asset.ok) await cache.put(path, asset) } catch { /* one asset cannot poison install */ } }))
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    try {
      const data = event.data?.json() || {}
      const { title, body, kind, tag, badge } = data
      // Sessions aren't URL-addressable in /next yet — deeplink to app root
      // (which resolves to the chat tab) rather than fabricate a query param
      // nothing reads.
      const url = '/next/'

      // Turn-kind: skip notification if app is visible
      if (kind === 'turn') {
        const clients = await self.clients.matchAll({ type: 'window' })
        if (clients.some(c => c.visibilityState === 'visible')) {
          // Skip notification but still update badge
          if ('setAppBadge' in navigator) {
            if (badge > 0) await navigator.setAppBadge(badge)
            else await navigator.clearAppBadge()
          }
          return
        }
      }

      // Show notification
      await self.registration.showNotification(title || 'Gary', { body, tag, data: { url } })

      // Update badge
      if ('setAppBadge' in navigator) {
        if (badge > 0) await navigator.setAppBadge(badge)
        else await navigator.clearAppBadge()
      }
    } catch (e) {
      // Malformed payload: log and continue
      console.debug('Push event error:', e)
    }
  })())
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const url = event.notification.data?.url || '/next/'
    const clients = await self.clients.matchAll({ type: 'window' })
    const existing = clients.find(c => c.url.includes('/next/'))
    if (existing) {
      await existing.focus()
      if (typeof existing.navigate === 'function') await existing.navigate(url)
      else await existing.postMessage({ type: 'navigate', url })
    } else {
      await self.clients.openWindow(url)
    }
  })())
})
self.addEventListener('install', event => { event.waitUntil(cacheShell().catch(() => undefined)) })
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('workspace-next-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())) })
self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting() })
self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return
  const navigation = request.mode === 'navigate' && url.pathname.startsWith('/next')
  const code = url.pathname.startsWith('/next/assets/')
  if (navigation || code) {
    const key = navigation ? SHELL : request
    event.respondWith(fetchFresh(request).then(async response => { if (response.ok) { const cache = await caches.open(CACHE); await cache.put(key, response.clone()); if (navigation) cacheShell().catch(() => undefined) } return response }).catch(() => caches.match(key).then(cached => cached || (navigation ? caches.match(SHELL) : undefined))))
    return
  }
  if (url.pathname.startsWith('/static/')) event.respondWith(caches.open(CACHE).then(async cache => { const cached = await cache.match(request); const network = fetch(request).then(response => { if (response.ok) cache.put(request, response.clone()); return response }).catch(() => cached); return cached || network }))
})
