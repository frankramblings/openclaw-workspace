import { beforeEach, expect, test, vi } from 'vitest'
import { usePwaStore } from './store'

beforeEach(() => usePwaStore.setState({ supported: true, online: true, standalone: false, installReady: false, updateReady: false, error: null, pushState: 'unsupported', pushError: null }))

test('registers a /next-scoped worker and explicitly activates waiting updates', async () => {
  const waiting = { postMessage: vi.fn() }
  const registration = Object.assign(new EventTarget(), { waiting, installing: null, update: vi.fn(async () => undefined) })
  const serviceWorker = Object.assign(new EventTarget(), { controller: {}, register: vi.fn(async () => registration) })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
  const stop = usePwaStore.getState().init()
  await vi.waitFor(() => expect(serviceWorker.register).toHaveBeenCalledWith('/next/sw.js', { scope: '/next/' }))
  expect(usePwaStore.getState().updateReady).toBe(true)
  await usePwaStore.getState().applyUpdate()
  expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  stop()
})

test('captures install prompt and clears it after acceptance', async () => {
  const registration = Object.assign(new EventTarget(), { waiting: null, installing: null, update: vi.fn(async () => undefined) })
  const serviceWorker = Object.assign(new EventTarget(), { controller: null, register: vi.fn(async () => registration) })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
  const stop = usePwaStore.getState().init()
  const prompt = vi.fn(async () => undefined)
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: 'accepted' as const }) })
  window.dispatchEvent(event)
  expect(usePwaStore.getState().installReady).toBe(true)
  await usePwaStore.getState().install()
  expect(prompt).toHaveBeenCalled()
  expect(usePwaStore.getState().installReady).toBe(false)
  stop()
})

test('tracks online and offline lifecycle', () => {
  const serviceWorker = Object.assign(new EventTarget(), { controller: null, register: vi.fn(async () => Object.assign(new EventTarget(), { waiting: null, installing: null })) })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
  const stop = usePwaStore.getState().init()
  window.dispatchEvent(new Event('offline')); expect(usePwaStore.getState().online).toBe(false)
  window.dispatchEvent(new Event('online')); expect(usePwaStore.getState().online).toBe(true)
  stop()
})

// Push notification state transition tests
test('enablePush stays off when permission denied', async () => {
  const requestPermission = vi.fn(async () => 'denied')
  const pushManager = { subscribe: vi.fn() }
  const registration = Object.assign(new EventTarget(), { pushManager, waiting: null, installing: null, update: vi.fn(async () => undefined) })
  const serviceWorker = Object.assign(new EventTarget(), { controller: null, register: vi.fn(async () => registration) })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
  Object.defineProperty(window, 'Notification', { configurable: true, value: { requestPermission, permission: 'default' } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ supported: true, publicKey: 'YWJj' }))))
  const stop = usePwaStore.getState().init()
  await vi.waitFor(() => expect(serviceWorker.register).toHaveBeenCalled())
  await usePwaStore.getState().enablePush()
  expect(requestPermission).toHaveBeenCalled()
  expect(pushManager.subscribe).not.toHaveBeenCalled()
  expect(usePwaStore.getState().pushState).toBe('no-permission')
  expect(usePwaStore.getState().pushError).toBeTruthy()
  stop()
  vi.unstubAllGlobals()
})

test('enablePush flips on only after subscribe and POST both succeed', async () => {
  let postShouldFail = true
  const requestPermission = vi.fn(async () => 'granted')
  const sub = { toJSON: () => ({ endpoint: 'https://example.com', keys: { p256dh: 'test' } }) }
  const subscribe = vi.fn(async () => sub)
  const pushManager = { subscribe, getSubscription: vi.fn(async () => null) }
  const registration = Object.assign(new EventTarget(), { pushManager, waiting: null, installing: null, update: vi.fn(async () => undefined) })
  const serviceWorker = Object.assign(new EventTarget(), { controller: null, register: vi.fn(async () => registration) })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
  Object.defineProperty(window, 'Notification', { configurable: true, value: { requestPermission, permission: 'default' } })
  const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/push/subscribe' && init?.method === 'POST' && postShouldFail) throw new Error('POST failed')
    if (path === '/api/push/status') return new Response(JSON.stringify({ supported: true, publicKey: 'YWJj' }))
    if (path === '/api/push/subscribe' && init?.method === 'POST') return new Response(JSON.stringify({ ok: true }))
    return new Response(JSON.stringify({}))
  })
  vi.stubGlobal('fetch', fetchFn)
  const stop = usePwaStore.getState().init()
  await vi.waitFor(() => expect(serviceWorker.register).toHaveBeenCalled())
  await usePwaStore.getState().enablePush()
  expect(usePwaStore.getState().pushState).not.toBe('on')
  expect(usePwaStore.getState().pushError).toBeTruthy()
  postShouldFail = false
  await usePwaStore.getState().enablePush()
  expect(usePwaStore.getState().pushState).toBe('on')
  stop()
  vi.unstubAllGlobals()
})

test('push not supported when pushManager absent', async () => {
  const registration = Object.assign(new EventTarget(), { waiting: null, installing: null, update: vi.fn(async () => undefined) })
  const serviceWorker = Object.assign(new EventTarget(), { controller: null, register: vi.fn(async () => registration) })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
  const stop = usePwaStore.getState().init()
  await vi.waitFor(() => expect(serviceWorker.register).toHaveBeenCalled())
  await usePwaStore.getState().syncPushState()
  expect(usePwaStore.getState().pushState).toBe('unsupported')
  stop()
})

test('push feature-detects setAppBadge', async () => {
  Reflect.deleteProperty(navigator, 'setAppBadge')
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ unseen: 3 })))
  vi.stubGlobal('fetch', fetchFn)
  await expect(usePwaStore.getState().syncBadge()).resolves.toBeUndefined()
  expect(fetchFn).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

test('badge sync sets badge when unseen > 0', async () => {
  const setAppBadge = vi.fn(async () => undefined), clearAppBadge = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ unseen: 3 }))))
  await usePwaStore.getState().syncBadge()
  expect(setAppBadge).toHaveBeenCalledWith(3)
  expect(clearAppBadge).not.toHaveBeenCalled()
  Reflect.deleteProperty(navigator, 'setAppBadge'); Reflect.deleteProperty(navigator, 'clearAppBadge')
  vi.unstubAllGlobals()
})

test('badge sync clears badge when unseen is 0', async () => {
  const setAppBadge = vi.fn(async () => undefined), clearAppBadge = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ unseen: 0 }))))
  await usePwaStore.getState().syncBadge()
  expect(clearAppBadge).toHaveBeenCalled()
  expect(setAppBadge).not.toHaveBeenCalled()
  Reflect.deleteProperty(navigator, 'setAppBadge'); Reflect.deleteProperty(navigator, 'clearAppBadge')
  vi.unstubAllGlobals()
})

test('disablePush unsubscribes and posts unsubscribe', async () => {
  const writes: Array<{ path: string; body: unknown }> = []
  const unsubscribe = vi.fn(async () => undefined)
  const sub = { toJSON: () => ({ endpoint: 'https://example.com' }), unsubscribe }
  const pushManager = { getSubscription: vi.fn(async () => sub) }
  const registration = Object.assign(new EventTarget(), { pushManager, waiting: null, installing: null, update: vi.fn(async () => undefined) })
  const serviceWorker = Object.assign(new EventTarget(), { controller: null, register: vi.fn(async () => registration) })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
  const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input)
    if (init?.body) writes.push({ path, body: JSON.parse(String(init.body)) })
    if (path === '/api/push/unsubscribe' && init?.method === 'POST') return new Response(JSON.stringify({ ok: true }))
    return new Response(JSON.stringify({}))
  })
  vi.stubGlobal('fetch', fetchFn)
  const stop = usePwaStore.getState().init()
  await vi.waitFor(() => expect(serviceWorker.register).toHaveBeenCalled())
  await usePwaStore.getState().disablePush()
  expect(unsubscribe).toHaveBeenCalled()
  expect(writes).toContainEqual({ path: '/api/push/unsubscribe', body: { endpoint: 'https://example.com' } })
  expect(usePwaStore.getState().pushState).toBe('off')
  stop()
  vi.unstubAllGlobals()
})
