import { beforeEach, expect, test, vi } from 'vitest'
import { usePwaStore } from './store'

beforeEach(() => usePwaStore.setState({ supported: true, online: true, standalone: false, installReady: false, updateReady: false, error: null }))

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
