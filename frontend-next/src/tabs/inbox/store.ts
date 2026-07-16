import { create } from 'zustand'
import { apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { ActionResponse, HistoryResponse, InboxItem, ItemsResponse } from './types'

interface InboxState {
  feed: Remote<ItemsResponse>
  history: Remote<HistoryResponse>
  detail: Remote<unknown>
  selected: InboxItem | null
  pendingId: string | null
  load(): Promise<void>
  select(item: InboxItem): Promise<void>
  act(item: InboxItem, action: string): Promise<void>
  undo(ts: number): Promise<void>
  triage(): Promise<void>
  spinoff(item: InboxItem): Promise<void>
}

const feedLoader = makeLoader<ItemsResponse>()
const historyLoader = makeLoader<HistoryResponse>()
const detailLoader = makeLoader<unknown>()

export const useInboxStore = create<InboxState>((set, get) => {
  const load = async () => {
    await Promise.all([
      feedLoader(() => apiGet('/api/items'), (feed) => set({ feed }), get().feed),
      historyLoader(() => apiGet('/api/items/history'), (history) => set({ history }), get().history),
    ])
  }
  return {
    feed: idle, history: idle, detail: idle, selected: null, pendingId: null, load,
    select: async (item) => {
      set({ selected: item, detail: idle })
      const meta = item.meta
      let path: string | null = null
      if (item.source === 'slack' && meta.channelId && meta.threadTs) path = `/api/inbox/slack/thread?channel_id=${encodeURIComponent(String(meta.channelId))}&thread_ts=${encodeURIComponent(String(meta.threadTs))}`
      if (item.source === 'asana' && (meta.gid || item.id)) path = `/api/inbox/asana/task?gid=${encodeURIComponent(String(meta.gid ?? item.id))}`
      if (path) await detailLoader(() => apiGet(path!), (detail) => set({ detail }), get().detail)
    },
    act: async (item, rawAction) => {
      set({ pendingId: item.id })
      try {
        const [action, response] = rawAction.split(':')
        const result = await apiJson<ActionResponse>('POST', '/api/items/action', { source: item.source, id: item.id, action, ...(action === 'rsvp' ? { response } : {}), title: item.title, snippet: item.snippet, meta: item.meta })
        if (!result.ok) throw new Error(result.error ?? 'Action failed')
        await load()
      } finally { set({ pendingId: null }) }
    },
    undo: async (ts) => { await apiJson('POST', '/api/items/undo', { ts }); await load() },
    triage: async () => { await apiJson('POST', '/api/items/triage', {}); await load() },
    spinoff: async (item) => { await apiJson('POST', '/api/items/spinoff', { item }); await load() },
  }
})

