import { create } from 'zustand'
import { apiDelete, apiGet, apiJson, openJsonSSE } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { ActiveRun, ResearchLibrary, ResearchProgress, ResearchResult } from './types'

interface ResearchState {
  library: Remote<ResearchLibrary>
  active: Remote<ActiveRun[]>
  result: Remote<ResearchResult>
  selectedId: string | null
  runId: string | null
  query: string
  progress: ResearchProgress[]
  error: string | null
  pending: string | null
  load(): Promise<void>
  start(query: string, maxRounds?: number, category?: string): Promise<void>
  resume(id: string, query?: string): void
  open(id: string): Promise<void>
  cancel(): Promise<void>
  archive(id: string): Promise<void>
  remove(id: string): Promise<void>
  spinoff(id: string): Promise<string | null>
}

const libraryLoader = makeLoader<ResearchLibrary>()
const activeLoader = makeLoader<ActiveRun[]>()
const resultLoader = makeLoader<ResearchResult>()
let source: EventSource | null = null
let poll: number | null = null
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export const useResearchStore = create<ResearchState>((set, get) => {
  const load = async () => Promise.all([
    libraryLoader(() => apiGet('/api/research/library?limit=200'), library => set({ library }), get().library),
    activeLoader(async () => (await apiGet<{ active: ActiveRun[] }>('/api/research/active')).active, active => set({ active }), get().active),
  ]).then(() => undefined)
  const stopWatch = () => { source?.close(); source = null; if (poll !== null) window.clearInterval(poll); poll = null }
  const finish = async (id: string, frame: ResearchProgress) => {
    stopWatch()
    set(state => ({ runId: null, progress: [...state.progress, frame], error: frame.error || (frame.status === 'error' ? 'Research failed' : null) }))
    if (!frame.error && frame.status !== 'error' && frame.status !== 'cancelled') await get().open(id)
    await load()
  }
  const resume = (id: string, query = '') => {
    stopWatch()
    set({ runId: id, query, progress: [], error: null })
    source = openJsonSSE<ResearchProgress>(`/api/research/stream/${encodeURIComponent(id)}`, frame => {
      if (get().runId !== id) return
      if (frame.final || frame.phase === 'done' || ['done', 'error', 'cancelled'].includes(frame.status ?? '')) { void finish(id, frame); return }
      set(state => ({ progress: [...state.progress, frame].slice(-100), ...(frame.error ? { error: frame.error } : {}) }))
    })
    poll = window.setInterval(() => void apiGet<{ status: string; progress: ResearchProgress }>(`/api/research/status/${encodeURIComponent(id)}`).then(status => {
      if (get().runId !== id) return
      if (['done', 'error', 'cancelled'].includes(status.status)) void finish(id, { ...status.progress, status: status.status, final: true })
    }).catch(error => set({ error: message(error) })), 5000)
  }
  const mutate = async (id: string, operation: () => Promise<unknown>) => {
    set({ pending: id, error: null })
    try { await operation(); await load() } catch (error) { set({ error: message(error) }) } finally { set({ pending: null }) }
  }
  return {
    library: idle,
    active: idle,
    result: idle,
    selectedId: null,
    runId: null,
    query: '',
    progress: [],
    error: null,
    pending: null,
    load,
    start: async (query, max_rounds = 2, category = '') => {
      set({ pending: 'start', error: null })
      try { const response = await apiJson<{ session_id: string }>('POST', '/api/research/start', { query, max_rounds, category }); resume(response.session_id, query); await load() } catch (error) { set({ error: message(error) }) } finally { set({ pending: null }) }
    },
    resume,
    open: async id => { set({ selectedId: id }); await resultLoader(() => apiJson('POST', `/api/research/result-peek/${encodeURIComponent(id)}`, {}), result => set({ result }), get().result) },
    cancel: async () => { const id = get().runId; if (!id) return; set({ pending: id, error: null }); try { await apiJson('POST', `/api/research/cancel/${encodeURIComponent(id)}`); stopWatch(); set({ runId: null, progress: [...get().progress, { final: true, status: 'cancelled', phase: 'cancelled' }] }); await load() } catch (error) { set({ error: message(error) }) } finally { set({ pending: null }) } },
    archive: id => mutate(id, async () => { const response = await apiJson<{ ok: boolean }>('POST', `/api/research/${encodeURIComponent(id)}/archive`); if (!response.ok) throw new Error('Archive failed'); if (get().selectedId === id) set({ selectedId: null, result: idle }) }),
    remove: id => mutate(id, async () => { const response = await apiDelete<{ ok: boolean }>(`/api/research/${encodeURIComponent(id)}`); if (!response.ok) throw new Error('Delete failed'); if (get().selectedId === id) set({ selectedId: null, result: idle }) }),
    spinoff: async id => { set({ pending: id, error: null }); try { return (await apiJson<{ session_id: string }>('POST', `/api/research/spinoff/${encodeURIComponent(id)}`, {})).session_id } catch (error) { set({ error: message(error) }); return null } finally { set({ pending: null }) } },
  }
})
