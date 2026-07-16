import { create } from 'zustand'
import { apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { ActionResponse, HistoryResponse, InboxItem, ItemActionOptions, ItemsResponse, SpinoffResponse } from './types'

interface InboxState {
  feed: Remote<ItemsResponse>
  history: Remote<HistoryResponse>
  detail: Remote<unknown>
  selected: InboxItem | null
  pendingKey: string | null
  selection: string[]
  error: string | null
  notice: { message: string; undoTs?: number } | null
  triaging: boolean
  load(): Promise<void>
  select(item: InboxItem | null): Promise<void>
  act(item: InboxItem, action: string, options?: ItemActionOptions): Promise<boolean>
  undo(ts: number): Promise<boolean>
  triage(): Promise<void>
  spinoff(items: InboxItem | InboxItem[], intent?: string): Promise<string | null>
  toggleSelection(item: InboxItem): void
  clearNotice(): void
}

const feedLoader = makeLoader<ItemsResponse>()
const historyLoader = makeLoader<HistoryResponse>()
const detailLoader = makeLoader<unknown>()
const keyOf = (item: InboxItem) => `${item.source}:${item.id}`
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export const useInboxStore = create<InboxState>((set, get) => {
  const load = async () => {
    await Promise.all([
      feedLoader(() => apiGet('/api/items'), feed => set({ feed }), get().feed),
      historyLoader(() => apiGet('/api/items/history?limit=20'), history => set({ history }), get().history),
    ])
  }
  return {
    feed: idle,
    history: idle,
    detail: idle,
    selected: null,
    pendingKey: null,
    selection: [],
    error: null,
    notice: null,
    triaging: false,
    load,
    select: async item => {
      if (!item) { set({ selected: null, detail: idle }); return }
      set({ selected: item, detail: idle, error: null })
      const meta = item.meta
      let path: string | null = null
      if (item.source === 'gmail' && (meta.uid || item.id)) path = `/api/email/read/${encodeURIComponent(String(meta.uid ?? item.id))}?mark_seen=false`
      if (item.source === 'slack' && (meta.channelId || meta.channel)) path = `/api/inbox/slack/thread?channel_id=${encodeURIComponent(String(meta.channelId ?? meta.channel))}&thread_ts=${encodeURIComponent(String(meta.threadTs ?? item.id))}`
      if (item.source === 'asana') path = `/api/inbox/asana/task?gid=${encodeURIComponent(String(meta.gid ?? item.id))}`
      if (path) await detailLoader(() => apiGet(path!), detail => { if (get().selected && keyOf(get().selected!) === keyOf(item)) set({ detail }) }, get().detail)
      else set({ detail: { status: 'ready', data: {}, fetchedAt: Date.now() } })
    },
    act: async (item, rawAction, options = {}) => {
      const key = keyOf(item)
      set({ pendingKey: key, error: null })
      try {
        const [action, embeddedResponse] = rawAction.split(':')
        const response = options.response ?? embeddedResponse
        const result = await apiJson<ActionResponse>('POST', '/api/items/action', {
          source: item.source,
          id: item.id,
          action,
          ...(response ? { response } : {}),
          ...options,
          title: item.title,
          snippet: item.snippet,
          meta: item.meta,
        })
        if (!result.ok) throw new Error(result.error ?? 'Action failed')
        set(state => ({
          notice: { message: `${action === 'snooze' ? 'Snoozed' : action.replaceAll('_', ' ')} — ${item.title}`, ...(result.undoTs ? { undoTs: result.undoTs } : {}) },
          selected: state.selected && keyOf(state.selected) === key ? null : state.selected,
          selection: state.selection.filter(itemKey => itemKey !== key),
          feed: state.feed.status === 'ready' ? { status: 'ready', data: { ...state.feed.data, items: state.feed.data.items.filter(row => keyOf(row) !== key), total: Math.max(0, state.feed.data.total - 1), sources: { ...state.feed.data.sources, [item.source]: Math.max(0, (state.feed.data.sources[item.source] ?? 1) - 1) } }, fetchedAt: Date.now() } : state.feed,
        }))
        void historyLoader(() => apiGet('/api/items/history?limit=20'), history => set({ history }), get().history)
        return true
      } catch (error) {
        set({ error: message(error) })
        return false
      } finally {
        set({ pendingKey: null })
      }
    },
    undo: async ts => {
      set({ error: null })
      try {
        const result = await apiJson<{ ok: boolean; error?: string }>('POST', '/api/items/undo', { ts })
        if (!result.ok) throw new Error(result.error ?? 'Undo failed')
        set({ notice: { message: 'Undone — item restored' } })
        await load()
        return true
      } catch (error) {
        set({ error: message(error) })
        return false
      }
    },
    triage: async () => {
      set({ triaging: true, error: null })
      try {
        const result = await apiJson<{ scored: number }>('POST', '/api/items/triage', {})
        set({ notice: { message: `AI triage scored ${result.scored} item${result.scored === 1 ? '' : 's'}` } })
        await load()
      } catch (error) {
        set({ error: message(error) })
      } finally {
        set({ triaging: false })
      }
    },
    spinoff: async (input, intent) => {
      const items = Array.isArray(input) ? input : [input]
      set({ pendingKey: items.length === 1 ? keyOf(items[0]) : 'bulk', error: null })
      try {
        const result = await apiJson<SpinoffResponse>('POST', '/api/items/spinoff', Array.isArray(input) ? { items } : { item: input, ...(intent ? { intent } : {}) })
        if (!result.session_id) throw new Error('No chat session returned')
        return result.session_id
      } catch (error) {
        set({ error: message(error) })
        return null
      } finally {
        set({ pendingKey: null })
      }
    },
    toggleSelection: item => set(state => { const key = keyOf(item); return { selection: state.selection.includes(key) ? state.selection.filter(value => value !== key) : [...state.selection, key] } }),
    clearNotice: () => set({ notice: null }),
  }
})
