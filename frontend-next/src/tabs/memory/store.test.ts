import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useMemoryStore } from './store'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const baseState = { memory: idle, sessions: idle, suggestions: [], suggestionSource: null, auditResult: null, pending: null, error: null }

beforeEach(() => useMemoryStore.setState(baseState))

test('loads memories and conversations, then persists edit and pin contracts', async () => {
  const requests: Array<{ path: string; method: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); requests.push({ path, method: init?.method || 'GET' })
    if (path === '/api/memory') return json({ memory: [{ id: 'm1', text: 'Fact', category: 'General', pinned: false, timestamp: 1, uses: 0, source: 'test' }] })
    if (path === '/api/sessions') return json([{ id: 's1', name: 'Conversation' }])
    if (path === '/api/memory/m1' || path === '/api/memory/m1/pin') return json({ ok: true })
    throw new Error(`unexpected request ${path}`)
  }))
  await useMemoryStore.getState().load()
  const memory = useMemoryStore.getState().memory
  expect(useMemoryStore.getState()).toMatchObject({ sessions: { status: 'ready', data: [{ id: 's1' }] } })
  if (memory.status !== 'ready') throw new Error('memory did not load')
  await useMemoryStore.getState().save(memory.data[0], 'Updated', 'Preference')
  await useMemoryStore.getState().pin(memory.data[0])
  expect(requests).toContainEqual({ path: '/api/memory/m1', method: 'PUT' })
  expect(requests).toContainEqual({ path: '/api/memory/m1/pin', method: 'POST' })
  vi.unstubAllGlobals()
})

test('audits and extracts reviewable suggestions without auto-saving', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/memory/audit') return json({ before: 4, after: 3, removed: 1 })
    if (path === '/api/memory/extract') return json({ suggestions: ['Likes tea', { text: 'Prefers dark mode', category: 'preference' }] })
    if (path === '/api/memory') return json({ memory: [] })
    if (path === '/api/sessions') return json([])
    throw new Error(`unexpected request ${path}`)
  }))
  expect(await useMemoryStore.getState().audit()).toBe(true)
  expect(await useMemoryStore.getState().extract('s1')).toBe(true)
  expect(useMemoryStore.getState()).toMatchObject({ auditResult: { removed: 1 }, suggestionSource: 'Conversation', suggestions: [{ text: 'Likes tea', category: 'fact' }, { text: 'Prefers dark mode', category: 'preference' }] })
  vi.unstubAllGlobals()
})

test('imports multipart suggestions and saves or dismisses them explicitly', async () => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/memory/import') { expect(init?.body).toBeInstanceOf(FormData); return json({ filename: 'notes.md', suggestions: [{ text: 'Candidate', category: 'General' }] }) }
    if (path === '/api/memory/add') { writes.push(JSON.parse(String(init?.body))); return json({ ok: true }) }
    if (path === '/api/memory') return json({ memory: [] })
    if (path === '/api/sessions') return json([])
    throw new Error(`unexpected request ${path}`)
  }))
  await useMemoryStore.getState().importFile(new File(['hello'], 'notes.md'), 's1')
  const id = useMemoryStore.getState().suggestions[0].id
  expect(await useMemoryStore.getState().saveSuggestion(id)).toBe(true)
  expect(writes).toEqual([{ text: 'Candidate', category: 'General' }])
  expect(useMemoryStore.getState().suggestions).toHaveLength(0)
  vi.unstubAllGlobals()
})

test('keeps mutation failures visible and supports partial bulk deletion', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/memory/bad') return json({ error: 'no' }, 502)
    if (path === '/api/memory/good') return json({ ok: true })
    if (path === '/api/memory') return json({ memory: [] })
    if (path === '/api/sessions') return json([])
    throw new Error(`unexpected request ${path}`)
  }))
  expect(await useMemoryStore.getState().remove('bad')).toBe(false)
  expect(useMemoryStore.getState().error).toContain('HTTP 502')
  expect(await useMemoryStore.getState().removeMany(['good', 'bad'])).toBe(1)
  expect(useMemoryStore.getState().error).toBe('Deleted 1 of 2 memories')
  vi.unstubAllGlobals()
})
