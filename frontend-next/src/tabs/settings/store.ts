import { create } from 'zustand'
import { apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { ActionResult, McpTool, SettingsSnapshot } from './types'

interface SettingsState {
  settings: Remote<SettingsSnapshot>
  tools: Remote<McpTool[]>
  selectedServer: string | null
  pending: string | null
  error: string | null
  result: ActionResult | null
  load(): Promise<void>
  saveSearch(body: { search_provider: string; search_result_count: number; search_fallback_chain: string[] }): Promise<boolean>
  testSearch(): Promise<boolean>
  saveDefault(model: string, endpoint_id: string): Promise<boolean>
  reconnect(id: string): Promise<boolean>
  openTools(id: string): Promise<void>
  closeTools(): void
}

const settingsLoader = makeLoader<SettingsSnapshot>(), toolsLoader = makeLoader<McpTool[]>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export const useSettingsStore = create<SettingsState>((set, get) => {
  const load = () => settingsLoader(async () => {
    const [config, capabilities, gateway, doctor, auth, defaultChat, email, calendar, mcp, models] = await Promise.all([
      apiGet<SettingsSnapshot['config']>('/api/config'), apiGet<SettingsSnapshot['capabilities']>('/api/capabilities'), apiGet<SettingsSnapshot['gateway']>('/api/gateway/status'), apiGet<SettingsSnapshot['doctor']>('/api/doctor'), apiGet<SettingsSnapshot['auth']>('/api/auth/settings'), apiGet<SettingsSnapshot['defaultChat']>('/api/default-chat'), apiGet<SettingsSnapshot['email']>('/api/email/config'), apiGet<SettingsSnapshot['calendar']>('/api/calendar/config'), apiGet<{ servers: SettingsSnapshot['mcp'] }>('/api/mcp/servers'), apiGet<{ items: SettingsSnapshot['models'] }>('/api/models'),
    ])
    return { config, capabilities, gateway, doctor, auth, defaultChat, email, calendar, mcp: mcp.servers || [], models: models.items || [] }
  }, settings => set({ settings }), get().settings)
  const action = async (key: string, work: () => Promise<ActionResult>, refresh = true) => {
    set({ pending: key, error: null, result: null })
    try { const result = await work(); set({ result }); if (refresh) await load(); return result.kind === 'success' } catch (error) { const value = message(error); set({ error: value, result: { kind: 'error', message: value } }); return false } finally { set({ pending: null }) }
  }
  return {
    settings: idle, tools: idle, selectedServer: null, pending: null, error: null, result: null,
    load,
    saveSearch: body => action('search-save', async () => { await apiJson('POST', '/api/auth/settings', body); return { kind: 'success', message: 'Search settings saved' } }),
    testSearch: () => action('search-test', async () => { const value = await apiJson<{ ok: boolean; count?: number; provider?: string; error?: string }>('POST', '/api/search/test', { query: 'OpenClaw connectivity test' }); return value.ok ? { kind: 'success', message: `Search OK · ${value.count || 0} results via ${value.provider || 'provider'}` } : { kind: 'error', message: value.error || 'Search test failed' } }, false),
    saveDefault: (model, endpoint_id) => action('default-chat', async () => { const value = await apiJson<{ ok: boolean }>('POST', '/api/default-chat', { model, endpoint_id }); if (!value.ok) throw new Error('Save failed'); return { kind: 'success', message: 'Default model saved for new chats' } }),
    reconnect: id => action(`mcp:${id}`, async () => { const value = await apiJson<{ ok: boolean }>('POST', `/api/mcp/servers/${encodeURIComponent(id)}/reconnect`); if (!value.ok) throw new Error('Reconnect failed'); return { kind: 'success', message: `${id} re-probed` } }),
    openTools: async id => { set({ selectedServer: id }); await toolsLoader(async () => (await apiGet<{ tools: McpTool[] }>(`/api/mcp/servers/${encodeURIComponent(id)}/tools`)).tools || [], tools => set({ tools }), get().tools) },
    closeTools: () => set({ selectedServer: null, tools: idle }),
  }
})
