import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useResearchStore } from './store'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
class FakeEventSource {
  static latest: FakeEventSource | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  constructor(public url: string) { FakeEventSource.latest = this }
  close() {}
  emit(body: unknown) { this.onmessage?.({ data: JSON.stringify(body), lastEventId: '' } as MessageEvent) }
}

beforeEach(() => {
  useResearchStore.setState({ library: idle, active: idle, result: idle, selectedId: null, runId: null, query: '', progress: [], error: null, pending: null })
  vi.stubGlobal('EventSource', FakeEventSource)
})

test('loads active/library records and opens report content with sources', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/research/library?limit=200') return json({ research: [{ id: 'r1', query: 'Why?', status: 'done' }] })
    if (path === '/api/research/active') return json({ active: [] })
    if (path === '/api/research/result-peek/r1') return json({ result: '# Answer', sources: ['https://example.com'], raw_findings: [], category: '' })
    throw new Error(`unexpected request ${path}`)
  }))
  await useResearchStore.getState().load()
  await useResearchStore.getState().open('r1')
  expect(useResearchStore.getState()).toMatchObject({ selectedId: 'r1', result: { status: 'ready', data: { result: '# Answer' } } })
  vi.unstubAllGlobals()
})

test('starts with explicit depth, consumes progress, and reconciles completion', async () => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); if (init?.body) writes.push(JSON.parse(String(init.body)))
    if (path === '/api/research/start') return json({ session_id: 'run1' })
    if (path === '/api/research/library?limit=200') return json({ research: [] })
    if (path === '/api/research/active') return json({ active: [] })
    if (path === '/api/research/result-peek/run1') return json({ result: 'Done', sources: [], raw_findings: [], category: 'tech' })
    throw new Error(`unexpected request ${path}`)
  }))
  await useResearchStore.getState().start('Investigate', 3, 'tech')
  expect(writes[0]).toEqual({ query: 'Investigate', max_rounds: 3, category: 'tech' })
  FakeEventSource.latest?.emit({ phase: 'searching', round: 1, total_sources: 4 })
  expect(useResearchStore.getState().progress.at(-1)).toMatchObject({ phase: 'searching', total_sources: 4 })
  FakeEventSource.latest?.emit({ phase: 'done', status: 'done', final: true })
  await vi.waitFor(() => expect(useResearchStore.getState()).toMatchObject({ runId: null, selectedId: 'run1', result: { status: 'ready' } }))
  vi.unstubAllGlobals()
})

test('archives, deletes and discusses reports with visible failures', async () => {
  let fail = false
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); paths.push(path)
    if (fail) return json({ error: 'down' }, 502)
    if (path === '/api/research/r1/archive' || path === '/api/research/r1') return json({ ok: true })
    if (path === '/api/research/spinoff/r1') return json({ session_id: 'chat1' })
    if (path === '/api/research/library?limit=200') return json({ research: [] })
    if (path === '/api/research/active') return json({ active: [] })
    throw new Error(`unexpected request ${path}`)
  }))
  await useResearchStore.getState().archive('r1')
  await useResearchStore.getState().remove('r1')
  expect(await useResearchStore.getState().spinoff('r1')).toBe('chat1')
  fail = true
  expect(await useResearchStore.getState().spinoff('r1')).toBeNull()
  expect(useResearchStore.getState().error).toContain('HTTP 502')
  vi.unstubAllGlobals()
})
