import { create } from 'zustand'
import { apiDelete, apiForm, apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { MemoryItem } from './types'

interface MemoryState {
  memory: Remote<MemoryItem[]>
  load(): Promise<void>
  add(text: string, category: string): Promise<void>
  save(item: MemoryItem, text: string, category: string): Promise<void>
  pin(item: MemoryItem): Promise<void>
  remove(id: string): Promise<void>
}

const loader = makeLoader<MemoryItem[]>()
export const useMemoryStore = create<MemoryState>((set, get) => {
  const load = () => loader(async () => (await apiGet<{ memory: MemoryItem[] }>('/api/memory')).memory, (memory) => set({ memory }), get().memory)
  return {
    memory: idle,
    load,
    add: async (text, category) => { await apiJson('POST', '/api/memory/add', { text, category }); await load() },
    save: async (item, text, category) => { await apiForm(`/api/memory/${encodeURIComponent(item.id)}`, { text, category }, 'PUT'); await load() },
    pin: async (item) => { const result = await apiForm<{ ok: boolean }>(`/api/memory/${encodeURIComponent(item.id)}/pin`, { pinned: String(!item.pinned) }); if (!result.ok) throw new Error('Pin failed'); await load() },
    remove: async (id) => { const result = await apiDelete<{ ok: boolean }>(`/api/memory/${encodeURIComponent(id)}`); if (!result.ok) throw new Error('Delete failed'); await load() },
  }
})
