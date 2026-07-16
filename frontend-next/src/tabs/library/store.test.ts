import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useLibraryStore } from './store'
import type { LibraryItem } from './types'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const item = (kind: LibraryItem['kind'], id = 'one', content = ''): LibraryItem => ({ id, kind, title: id, snippet: content, content, updated: 10, meta: kind })

beforeEach(() => useLibraryStore.setState({ library: idle, detail: idle, selected: null, pending: null, error: null }))

test('merges chats, documents, code, notes and research with archive metadata', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.startsWith('/api/documents/library')) return json({ documents: [{ id: 'd1', title: 'Doc', language: 'markdown', preview: 'Body', updated_at: '2026-01-01', version_count: 2 }, { id: 'c1', title: 'Code', language: 'python', preview: 'print(1)', updated_at: '2026-01-02', version_count: 1 }] })
    if (path.startsWith('/api/research/library')) return json({ research: [{ id: 'r1', query: 'Report', status: 'done', started_at: 10, source_count: 3 }] })
    if (path === '/api/notes?archived=false') return json({ notes: [{ id: 'n1', title: 'Note', content: 'Text', updated: '2026-01-03' }] })
    if (path === '/api/notes?archived=true') return json({ notes: [{ id: 'n2', title: 'Old note', content: '', archived: true, updated: '2025-01-01' }] })
    if (path === '/api/sessions') return json([{ id: 's1', name: 'Chat', model: 'gpt', archived: true, updated: 20, created: 1 }])
    throw new Error(`unexpected request ${path}`)
  }))
  await useLibraryStore.getState().load()
  const remote = useLibraryStore.getState().library
  if (remote.status !== 'ready') throw new Error('library did not load')
  expect(remote.data.items.map(value => value.kind)).toEqual(expect.arrayContaining(['chat', 'document', 'code', 'note', 'research']))
  expect(remote.data.items.find(value => value.id === 's1')).toMatchObject({ archived: true })
  expect(remote.data.sourceErrors).toEqual([])
  vi.unstubAllGlobals()
})

test('keeps healthy sources when one library source fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.startsWith('/api/documents/library')) return json({ detail: 'down' }, 502)
    if (path.startsWith('/api/research/library')) return json({ research: [] })
    if (path.startsWith('/api/notes')) return json({ notes: [] })
    if (path === '/api/sessions') return json([])
    throw new Error(`unexpected request ${path}`)
  }))
  await useLibraryStore.getState().load()
  expect(useLibraryStore.getState().library).toMatchObject({ status: 'ready', data: { sourceErrors: ['documents'] } })
  vi.unstubAllGlobals()
})

test('opens native detail for document, note, research and chat', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/document/d1') return json({ current_content: '# Document' })
    if (path === '/api/research/result-peek/r1') return json({ result: '# Report', sources: ['https://example.com'] })
    if (path === '/api/history/s1?limit=40') return json({ history: [{ role: 'user', content: [{ text: 'Hello' }] }], model: 'gpt' })
    throw new Error(`unexpected request ${path}`)
  }))
  await useLibraryStore.getState().open(item('document', 'd1'))
  expect(useLibraryStore.getState().detail).toMatchObject({ status: 'ready', data: { markdown: '# Document' } })
  await useLibraryStore.getState().open(item('note', 'n1', 'Note body'))
  expect(useLibraryStore.getState().detail).toMatchObject({ status: 'ready', data: { markdown: 'Note body' } })
  await useLibraryStore.getState().open(item('research', 'r1'))
  expect(useLibraryStore.getState().detail).toMatchObject({ status: 'ready', data: { markdown: '# Report' } })
  await useLibraryStore.getState().open(item('chat', 's1'))
  expect(useLibraryStore.getState().detail).toMatchObject({ status: 'ready', data: { messages: [{ role: 'user', content: 'Hello' }] } })
  vi.unstubAllGlobals()
})

test('restores archived chats and surfaces failures', async () => {
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (fail) return json({ detail: 'restore failed' }, 502)
    if (path === '/api/session/s1/restore') return json({ ok: true })
    if (path.startsWith('/api/documents/library')) return json({ documents: [] })
    if (path.startsWith('/api/research/library')) return json({ research: [] })
    if (path.startsWith('/api/notes')) return json({ notes: [] })
    if (path === '/api/sessions') return json([])
    throw new Error(`unexpected request ${path}`)
  }))
  expect(await useLibraryStore.getState().restore({ ...item('chat', 's1'), archived: true })).toBe(true)
  fail = true
  expect(await useLibraryStore.getState().restore({ ...item('chat', 's1'), archived: true })).toBe(false)
  expect(useLibraryStore.getState().error).toContain('HTTP 502')
  vi.unstubAllGlobals()
})
