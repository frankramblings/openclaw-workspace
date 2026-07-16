import { create } from 'zustand'
import { ApiError, apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { CronJob, CronRun, LiveJob } from './types'

interface CronState {
  cron: Remote<{ jobs: CronJob[]; total: number; enabled?: boolean; error?: string }>
  runs: Remote<CronRun[]>
  jobs: Remote<LiveJob[]>
  log: Remote<string>
  selectedCron: string | null
  selectedJob: string | null
  streamStatus: 'idle' | 'connecting' | 'live' | 'error'
  pending: string | null
  error: string | null
  load(): Promise<void>
  watch(): () => void
  showRuns(id: string): Promise<void>
  action(job: CronJob, verb: 'run' | 'enable' | 'disable'): Promise<boolean>
  showLog(id: string): Promise<void>
  clearSelection(): void
}

const cronLoader = makeLoader<{ jobs: CronJob[]; total: number; enabled?: boolean; error?: string }>()
const runsLoader = makeLoader<CronRun[]>()
const jobsLoader = makeLoader<LiveJob[]>()
let stream: EventSource | null = null
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export const useCronStore = create<CronState>((set, get) => {
  const load = async () => Promise.all([
    cronLoader(() => apiGet('/api/cron'), cron => set({ cron }), get().cron),
    jobsLoader(async () => (await apiGet<{ jobs: LiveJob[] }>('/api/jobs')).jobs, jobs => set({ jobs }), get().jobs),
  ]).then(() => undefined)
  const watch = () => {
    stream?.close()
    if (typeof EventSource === 'undefined') return () => undefined
    set({ streamStatus: 'connecting' })
    stream = new EventSource('/api/jobs/stream')
    stream.onopen = () => set({ streamStatus: 'live' })
    stream.onerror = () => set({ streamStatus: 'error' })
    stream.onmessage = event => { try { const frame = JSON.parse(String(event.data)) as { jobs?: LiveJob[] }; if (Array.isArray(frame.jobs)) set({ jobs: { status: 'ready', data: frame.jobs, fetchedAt: Date.now() }, streamStatus: 'live' }) } catch { /* keep last honest snapshot */ } }
    return () => { stream?.close(); stream = null; set({ streamStatus: 'idle' }) }
  }
  return {
    cron: idle,
    runs: idle,
    jobs: idle,
    log: idle,
    selectedCron: null,
    selectedJob: null,
    streamStatus: 'idle',
    pending: null,
    error: null,
    load,
    watch,
    showRuns: async id => { set({ selectedCron: id, selectedJob: null, log: idle }); await runsLoader(async () => (await apiGet<{ runs: CronRun[] }>(`/api/cron/${encodeURIComponent(id)}/runs?limit=100`)).runs, runs => set({ runs }), get().runs) },
    action: async (job, verb) => {
      set({ pending: job.id, error: null })
      try { const result = await apiJson<{ ok: boolean; error?: string }>('POST', `/api/cron/${encodeURIComponent(job.id)}/${verb}`); if (!result.ok) throw new Error(result.error ?? `${verb} failed`); await load(); if (get().selectedCron === job.id) await get().showRuns(job.id); return true } catch (error) { set({ error: message(error) }); return false } finally { set({ pending: null }) }
    },
    showLog: async id => {
      set({ selectedJob: id, selectedCron: null, log: { status: 'loading' }, error: null })
      try { const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/log?tail=1000`, { cache: 'no-store' }); if (!response.ok) throw new ApiError(response.status, await response.text()); set({ log: { status: 'ready', data: await response.text(), fetchedAt: Date.now() } }) } catch (error) { set({ log: { status: 'error', error: message(error) } }) }
    },
    clearSelection: () => set({ selectedCron: null, selectedJob: null, runs: idle, log: idle }),
  }
})
