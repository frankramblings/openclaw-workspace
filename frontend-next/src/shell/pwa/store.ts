import { create } from 'zustand'

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
interface PwaState { supported: boolean; online: boolean; standalone: boolean; installReady: boolean; updateReady: boolean; error: string | null; init(): () => void; install(): Promise<void>; applyUpdate(): Promise<void> }
let promptEvent: InstallPrompt | null = null
let registration: ServiceWorkerRegistration | null = null
let reloadForUpdate = false

export const usePwaStore = create<PwaState>((set) => ({
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  standalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
  installReady: false, updateReady: false, error: null,
  init: () => {
    const online = () => set({ online: true }), offline = () => set({ online: false })
    const beforeInstall = (event: Event) => { event.preventDefault(); promptEvent = event as InstallPrompt; set({ installReady: true }) }
    const installed = () => { promptEvent = null; set({ installReady: false, standalone: true }) }
    const controlled = () => { if (reloadForUpdate) location.reload() }
    window.addEventListener('online', online); window.addEventListener('offline', offline); window.addEventListener('beforeinstallprompt', beforeInstall); window.addEventListener('appinstalled', installed)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', controlled)
      navigator.serviceWorker.register('/next/sw.js', { scope: '/next/' }).then(value => {
        registration = value
        if (value.waiting) set({ updateReady: true })
        value.addEventListener('updatefound', () => { const worker = value.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) set({ updateReady: true }) }) })
      }).catch(error => set({ error: error instanceof Error ? error.message : String(error) }))
    }
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', installed); navigator.serviceWorker?.removeEventListener('controllerchange', controlled) }
  },
  install: async () => { if (!promptEvent) return; await promptEvent.prompt(); const choice = await promptEvent.userChoice; if (choice.outcome === 'accepted') { promptEvent = null; set({ installReady: false }) } },
  applyUpdate: async () => { if (!registration) return; if (!registration.waiting) await registration.update(); if (registration.waiting) { reloadForUpdate = true; registration.waiting.postMessage({ type: 'SKIP_WAITING' }) } },
}))
