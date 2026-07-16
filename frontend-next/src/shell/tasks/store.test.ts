import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useTaskPanel, type TaskRecord } from './store'

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const task = (patch: Partial<TaskRecord> = {}): TaskRecord => ({ id: 't1', kind: 'research', source: 'research', label: 'Investigate', state: 'running', created: 1, updated: 2, extra: {}, ...patch })
class FakeEventSource {
  static latest: FakeEventSource | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false
  constructor(public url: string) { FakeEventSource.latest = this }
  close() { this.closed = true }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent) }
}

beforeEach(() => { useTaskPanel.setState({ open: false, tasks: idle, selected: null, streamStatus: 'idle' }); FakeEventSource.latest = null; vi.stubGlobal('EventSource', FakeEventSource) })

test('loads the task snapshot and controls panel selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ tasks: [task()] })))
  useTaskPanel.getState().show(); await useTaskPanel.getState().load(); useTaskPanel.getState().select('t1')
  expect(useTaskPanel.getState()).toMatchObject({ open: true, selected: 't1', tasks: { status: 'ready', data: [{ id: 't1' }] } })
  useTaskPanel.getState().close(); expect(useTaskPanel.getState().open).toBe(false)
  vi.unstubAllGlobals()
})

test('replaces from SSE snapshot, merges updates and reports stream lifecycle', () => {
  const stop = useTaskPanel.getState().watch()
  expect(FakeEventSource.latest?.url).toBe('/api/tasks/stream')
  FakeEventSource.latest?.onopen?.()
  FakeEventSource.latest?.emit({ type: 'tasks.snapshot', tasks: [task()] })
  FakeEventSource.latest?.emit({ type: 'task.update', task: task({ state: 'stalled', detail: 'No output', updated: 3 }) })
  expect(useTaskPanel.getState()).toMatchObject({ streamStatus: 'live', tasks: { status: 'ready', data: [{ id: 't1', state: 'stalled', detail: 'No output' }] } })
  FakeEventSource.latest?.onerror?.(); expect(useTaskPanel.getState().streamStatus).toBe('error')
  const source = FakeEventSource.latest; stop(); expect(source?.closed).toBe(true); expect(useTaskPanel.getState().streamStatus).toBe('idle')
  vi.unstubAllGlobals()
})
