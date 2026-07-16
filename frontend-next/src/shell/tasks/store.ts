import { create } from 'zustand'
import { apiGet } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'

export interface TaskRecord { id: string; kind: string; source: string; label: string; session_key?: string | null; turn_id?: number | null; state: string; pct?: number | null; eta?: number | null; detail?: string; error?: string; tail?: string; created: number; updated: number; extra?: Record<string, unknown> }
interface TaskState { open: boolean; tasks: Remote<TaskRecord[]>; selected: string | null; streamStatus: 'idle' | 'connecting' | 'live' | 'error'; show(): void; close(): void; select(id: string | null): void; load(): Promise<void>; watch(): () => void }
const loader = makeLoader<TaskRecord[]>()
let stream: EventSource | null = null

export const useTaskPanel = create<TaskState>((set, get) => ({
  open: false, tasks: idle, selected: null, streamStatus: 'idle',
  show: () => set({ open: true }), close: () => set({ open: false }), select: selected => set({ selected }),
  load: () => loader(async () => (await apiGet<{ tasks: TaskRecord[] }>('/api/tasks')).tasks || [], tasks => set({ tasks }), get().tasks),
  watch: () => {
    stream?.close(); if (typeof EventSource === 'undefined') return () => undefined
    set({ streamStatus: 'connecting' }); stream = new EventSource('/api/tasks/stream')
    stream.onopen = () => set({ streamStatus: 'live' }); stream.onerror = () => set({ streamStatus: 'error' })
    stream.onmessage = event => { try { const frame = JSON.parse(String(event.data)) as { type?: string; tasks?: TaskRecord[]; task?: TaskRecord }; if (frame.type === 'tasks.snapshot' && Array.isArray(frame.tasks)) set({ tasks: { status: 'ready', data: frame.tasks, fetchedAt: Date.now() }, streamStatus: 'live' }); else if (frame.type === 'task.update' && frame.task) set(state => { const prior = state.tasks.status === 'ready' ? state.tasks.data : []; const next = [frame.task!, ...prior.filter(task => task.id !== frame.task!.id)].sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || b.updated - a.updated); return { tasks: { status: 'ready', data: next, fetchedAt: Date.now() }, streamStatus: 'live' } }) } catch { /* preserve last honest snapshot */ } }
    return () => { stream?.close(); stream = null; set({ streamStatus: 'idle' }) }
  },
}))
