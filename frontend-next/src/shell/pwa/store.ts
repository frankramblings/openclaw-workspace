import { create } from 'zustand'

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
export interface PwaState { supported: boolean; online: boolean; standalone: boolean; installReady: boolean; updateReady: boolean; error: string | null; pushState: 'unsupported' | 'no-permission' | 'off' | 'on'; pushError: string | null; init(): () => void; install(): Promise<void>; applyUpdate(): Promise<void>; syncPushState(): Promise<void>; enablePush(): Promise<void>; disablePush(): Promise<void>; syncBadge(): Promise<void> }
let promptEvent: InstallPrompt | null = null
let registration: ServiceWorkerRegistration | null = null
let reloadForUpdate = false

// Utility: convert base64url to Uint8Array for subscription
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)))
}

export const usePwaStore = create<PwaState>((set) => ({
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  standalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
  installReady: false, updateReady: false, error: null,
  pushState: 'unsupported', pushError: null,
  init: () => {
    const online = () => set({ online: true }), offline = () => set({ online: false })
    const beforeInstall = (event: Event) => { event.preventDefault(); promptEvent = event as InstallPrompt; set({ installReady: true }) }
    const installed = () => { promptEvent = null; set({ installReady: false, standalone: true }) }
    const controlled = () => { if (reloadForUpdate) location.reload() }
    const syncBadgeOnFocus = async () => { await fetch('/api/push/status').then(r => r.json()).then(s => { if ('setAppBadge' in navigator) (s.unseen > 0 ? navigator.setAppBadge(s.unseen) : navigator.clearAppBadge()).catch(() => {}) }).catch(() => {}) }
    window.addEventListener('online', online); window.addEventListener('offline', offline); window.addEventListener('beforeinstallprompt', beforeInstall); window.addEventListener('appinstalled', installed); window.addEventListener('focus', syncBadgeOnFocus); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncBadgeOnFocus() })
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', controlled)
      navigator.serviceWorker.register('/next/sw.js', { scope: '/next/' }).then(value => {
        registration = value
        if (value.waiting) set({ updateReady: true })
        value.addEventListener('updatefound', () => { const worker = value.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) set({ updateReady: true }) }) })
      }).catch(error => set({ error: error instanceof Error ? error.message : String(error) }))
    }
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', installed); window.removeEventListener('focus', syncBadgeOnFocus); navigator.serviceWorker?.removeEventListener('controllerchange', controlled) }
  },
  install: async () => { if (!promptEvent) return; await promptEvent.prompt(); const choice = await promptEvent.userChoice; if (choice.outcome === 'accepted') { promptEvent = null; set({ installReady: false }) } },
  applyUpdate: async () => { if (!registration) return; if (!registration.waiting) await registration.update(); if (registration.waiting) { reloadForUpdate = true; registration.waiting.postMessage({ type: 'SKIP_WAITING' }) } },
  syncPushState: async () => {
    if (!registration?.pushManager) { set({ pushState: 'unsupported', pushError: null }); return }
    try {
      const status = await fetch('/api/push/status').then(r => r.json())
      if (!status.supported) { set({ pushState: 'unsupported', pushError: null }); return }
      const sub = await registration.pushManager.getSubscription()
      if (sub) { set({ pushState: 'on', pushError: null }) }
      else if (Notification.permission === 'denied') { set({ pushState: 'no-permission', pushError: null }) }
      else { set({ pushState: 'off', pushError: null }) }
    } catch (error) { set({ pushState: 'off', pushError: error instanceof Error ? error.message : 'Failed to sync' }) }
  },
  enablePush: async () => {
    if (!registration?.pushManager) return
    try {
      set({ pushError: null })
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') { set({ pushState: 'no-permission', pushError: 'Notification permission denied' }); return }
      const status = await fetch('/api/push/status').then(r => r.json())
      if (!status.publicKey) throw new Error('No public key from server')
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey)
      })
      const res = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) })
      if (!res.ok) throw new Error(`Subscribe rejected (${res.status})`)
      set({ pushState: 'on' })
    } catch (error) { set({ pushError: error instanceof Error ? error.message : 'Enable failed' }) }
  },
  disablePush: async () => {
    if (!registration?.pushManager) return
    try {
      set({ pushError: null })
      const sub = await registration.pushManager.getSubscription()
      if (!sub) { set({ pushState: 'off' }); return }
      const data = sub.toJSON()
      await sub.unsubscribe()
      if (data.endpoint) await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: data.endpoint }) })
      set({ pushState: 'off' })
    } catch (error) { set({ pushError: error instanceof Error ? error.message : 'Disable failed' }) }
  },
  syncBadge: async () => {
    try {
      if (!('setAppBadge' in navigator)) return
      const status = await fetch('/api/push/status').then(r => r.json()).catch(() => null)
      if (!status?.unseen) await navigator.clearAppBadge()
      else await navigator.setAppBadge(status.unseen)
    } catch { /* badge sync is best-effort */ }
  },
}))
