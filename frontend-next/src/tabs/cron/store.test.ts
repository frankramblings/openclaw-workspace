import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useCronStore } from './store'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
class FakeEventSource {
  static latest: FakeEventSource | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false
  constructor(public url: string) { FakeEventSource.latest = this }
  close() { this.closed = true }
  emit(body: unknown) { this.onmessage?.({ data: JSON.stringify(body), lastEventId: '' } as MessageEvent) }
}

beforeEach(() => {
  useCronStore.setState({ cron: idle, runs: idle, jobs: idle, log: idle, selectedCron: null, selectedJob: null, streamStatus: 'idle', pending: null, error: null })
  FakeEventSource.latest = null
  vi.stubGlobal('EventSource', FakeEventSource)
})

test('loads scheduled and live jobs then follows stream snapshots', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/cron') return json({ jobs: [{ id: 'daily', name: 'Daily', enabled: true, schedule: '0 8 * * *' }], total: 1 })
    if (path === '/api/jobs') return json({ jobs: [] })
    throw new Error(`unexpected request ${path}`)
  }))
  await useCronStore.getState().load()
  const stop = useCronStore.getState().watch()
  expect(FakeEventSource.latest?.url).toBe('/api/jobs/stream')
  FakeEventSource.latest?.onopen?.()
  FakeEventSource.latest?.emit({ jobs: [{ id: 'live1', status: 'running', progress: 35 }] })
  expect(useCronStore.getState()).toMatchObject({ streamStatus: 'live', jobs: { status: 'ready', data: [{ id: 'live1', status: 'running', progress: 35 }] } })
  const source = FakeEventSource.latest
  stop()
  expect(source?.closed).toBe(true)
  expect(useCronStore.getState().streamStatus).toBe('idle')
  vi.unstubAllGlobals()
})

test('loads run history and sends actions with visible failures', async () => {
  const requests: Array<{ path: string; method: string }> = []
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); requests.push({ path, method: init?.method || 'GET' })
    if (fail) return json({ error: 'gateway unavailable' }, 502)
    if (path === '/api/cron/daily/runs?limit=100') return json({ runs: [{ ts: 10, status: 'ok', summary: 'done' }] })
    if (path === '/api/cron/daily/disable') return json({ ok: true })
    if (path === '/api/cron') return json({ jobs: [], total: 0 })
    if (path === '/api/jobs') return json({ jobs: [] })
    throw new Error(`unexpected request ${path}`)
  }))
  await useCronStore.getState().showRuns('daily')
  expect(useCronStore.getState()).toMatchObject({ selectedCron: 'daily', runs: { status: 'ready', data: [{ status: 'ok' }] } })
  expect(await useCronStore.getState().action({ id: 'daily', name: 'Daily', enabled: true, schedule: '0 8 * * *' }, 'disable')).toBe(true)
  expect(requests).toContainEqual({ path: '/api/cron/daily/disable', method: 'POST' })
  fail = true
  expect(await useCronStore.getState().action({ id: 'daily', name: 'Daily', enabled: true, schedule: '0 8 * * *' }, 'run')).toBe(false)
  expect(useCronStore.getState().error).toContain('HTTP 502')
  vi.unstubAllGlobals()
})

test('loads plaintext logs and exposes log request errors', async () => {
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async () => fail ? new Response('missing', { status: 404 }) : new Response('line one\nline two')))
  await useCronStore.getState().showLog('job/one')
  expect(useCronStore.getState()).toMatchObject({ selectedJob: 'job/one', log: { status: 'ready', data: 'line one\nline two' } })
  fail = true
  await useCronStore.getState().showLog('job/one')
  expect(useCronStore.getState().log).toMatchObject({ status: 'error', error: expect.stringContaining('HTTP 404') })
  vi.unstubAllGlobals()
})
