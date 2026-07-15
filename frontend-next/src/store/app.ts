import { create } from 'zustand'
import { apiGet } from '../api/client'
import { loadInto, idle, type Remote } from '../lib/remote'
import type { AppConfig, Capabilities } from '../api/types'

interface AppState {
  config: Remote<AppConfig>
  capabilities: Remote<Capabilities>
  loadConfig: () => Promise<void>
  loadCapabilities: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  config: idle,
  capabilities: idle,
  loadConfig: () =>
    loadInto(() => apiGet<AppConfig>('/api/config'), (config) => set({ config }), get().config),
  loadCapabilities: () =>
    loadInto(() => apiGet<Capabilities>('/api/capabilities'), (capabilities) => set({ capabilities }), get().capabilities),
}))
