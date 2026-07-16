import { create } from 'zustand'
import { ApiError, apiDelete, apiForm, apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { AuditResult, MemoryItem, MemorySession, MemorySuggestion } from './types'

interface MemoryState {
  memory: Remote<MemoryItem[]>
  sessions: Remote<MemorySession[]>
  suggestions: MemorySuggestion[]
  suggestionSource: string | null
  auditResult: AuditResult | null
  pending: string | null
  error: string | null
  load(): Promise<void>
  add(text: string, category: string): Promise<boolean>
  save(item: MemoryItem, text: string, category: string): Promise<boolean>
  pin(item: MemoryItem): Promise<boolean>
  remove(id: string): Promise<boolean>
  removeMany(ids: string[]): Promise<number>
  audit(): Promise<boolean>
  extract(session: string): Promise<boolean>
  importFile(file: File, session?: string): Promise<boolean>
  saveSuggestion(id: string): Promise<boolean>
  saveSuggestions(): Promise<number>
  dismissSuggestion(id: string): void
  clearSuggestions(): void
}

const memoryLoader = makeLoader<MemoryItem[]>()
const sessionsLoader = makeLoader<MemorySession[]>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const normalize = (values: Array<string | { text?: string; category?: string }>): MemorySuggestion[] => values.map((value, index) => ({ id: `${Date.now()}-${index}`, text: typeof value === 'string' ? value : value.text || '', category: typeof value === 'string' ? 'fact' : value.category || 'fact', selected: true })).filter(item => item.text.trim())

export const useMemoryStore = create<MemoryState>((set, get) => {
  const load = async () => Promise.all([
    memoryLoader(async () => { const value = await apiGet<{ memory?: MemoryItem[] } | MemoryItem[]>('/api/memory'); return Array.isArray(value) ? value : value.memory || [] }, memory => set({ memory }), get().memory),
    sessionsLoader(async () => { const value = await apiGet<MemorySession[] | { sessions: MemorySession[] }>('/api/sessions'); return Array.isArray(value) ? value : value.sessions }, sessions => set({ sessions }), get().sessions),
  ]).then(() => undefined)
  const mutate = async (key: string, action: () => Promise<unknown>) => {
    set({ pending: key, error: null })
    try { await action(); await load(); return true } catch (error) { set({ error: message(error) }); return false } finally { set({ pending: null }) }
  }
  const add = (text: string, category: string) => mutate('add', () => apiJson('POST', '/api/memory/add', { text: text.trim(), category }))
  return {
    memory: idle,
    sessions: idle,
    suggestions: [],
    suggestionSource: null,
    auditResult: null,
    pending: null,
    error: null,
    load,
    add,
    save: (item, text, category) => mutate(item.id, () => apiForm(`/api/memory/${encodeURIComponent(item.id)}`, { text: text.trim(), category }, 'PUT')),
    pin: item => mutate(item.id, async () => { const result = await apiForm<{ ok: boolean }>(`/api/memory/${encodeURIComponent(item.id)}/pin`, { pinned: String(!item.pinned) }); if (!result.ok) throw new Error('Pin failed') }),
    remove: id => mutate(id, async () => { const result = await apiDelete<{ ok: boolean }>(`/api/memory/${encodeURIComponent(id)}`); if (!result.ok) throw new Error('Delete failed') }),
    removeMany: async ids => {
      set({ pending: 'bulk-delete', error: null }); let removed = 0
      try { for (const id of ids) { try { const result = await apiDelete<{ ok: boolean }>(`/api/memory/${encodeURIComponent(id)}`); if (result.ok) removed++ } catch { /* report partial result below */ } } await load(); if (removed !== ids.length) set({ error: `Deleted ${removed} of ${ids.length} memories` }); return removed } finally { set({ pending: null }) }
    },
    audit: async () => {
      set({ pending: 'audit', error: null, auditResult: null })
      try { const result = await apiJson<AuditResult>('POST', '/api/memory/audit'); set({ auditResult: result }); await load(); return true } catch (error) { set({ error: message(error) }); return false } finally { set({ pending: null }) }
    },
    extract: async session => {
      set({ pending: 'extract', error: null })
      try { const result = await apiForm<{ suggestions?: Array<string | { text?: string; category?: string }> }>('/api/memory/extract', { session }); set({ suggestions: normalize(result.suggestions || []), suggestionSource: 'Conversation' }); return true } catch (error) { set({ error: message(error) }); return false } finally { set({ pending: null }) }
    },
    importFile: async (file, session) => {
      set({ pending: 'import', error: null })
      try { const form = new FormData(); form.append('file', file); if (session) form.append('session', session); const response = await fetch('/api/memory/import', { method: 'POST', body: form }); if (!response.ok) throw new ApiError(response.status, await response.text()); const result = await response.json() as { suggestions?: Array<string | { text?: string; category?: string }>; filename?: string }; set({ suggestions: normalize(result.suggestions || []), suggestionSource: result.filename || file.name }); return true } catch (error) { set({ error: message(error) }); return false } finally { set({ pending: null }) }
    },
    saveSuggestion: async id => {
      const item = get().suggestions.find(value => value.id === id); if (!item) return false
      const ok = await add(item.text, item.category); if (ok) set(state => ({ suggestions: state.suggestions.filter(value => value.id !== id) })); return ok
    },
    saveSuggestions: async () => {
      const items = get().suggestions.filter(item => item.selected); let saved = 0
      const savedIds = new Set<string>()
      set({ pending: 'save-suggestions', error: null })
      try { for (const item of items) { try { await apiJson('POST', '/api/memory/add', { text: item.text, category: item.category }); saved++; savedIds.add(item.id) } catch { /* preserve unsaved below */ } } set(state => ({ suggestions: state.suggestions.filter(item => !savedIds.has(item.id)) })); await load(); if (saved !== items.length) set({ error: `Saved ${saved} of ${items.length} suggestions` }); return saved } finally { set({ pending: null }) }
    },
    dismissSuggestion: id => set(state => ({ suggestions: state.suggestions.filter(item => item.id !== id) })),
    clearSuggestions: () => set({ suggestions: [], suggestionSource: null }),
  }
})
