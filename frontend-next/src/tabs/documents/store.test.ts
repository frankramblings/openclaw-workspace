import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useDocumentsStore } from './store'
import type { DocumentFull, DocumentLibrary } from './types'

const doc = (id: string, overrides: Partial<DocumentFull> = {}): DocumentFull => ({
  id,
  title: `Document ${id}`,
  language: 'markdown',
  preview: '',
  current_content: `Body ${id}`,
  updated_at: '2026-07-16T12:00:00Z',
  version_count: 1,
  archived: false,
  ...overrides,
})
const library = (documents: DocumentFull[] = []): DocumentLibrary => ({
  documents,
  total: documents.length,
  languages: { markdown: documents.length },
  session_count: 0,
})
const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

beforeEach(() => {
  localStorage.clear()
  useDocumentsStore.setState({
    library: idle,
    document: idle,
    versions: idle,
    selected: null,
    tabs: [],
    cache: {},
    saveState: 'idle',
    error: null,
    query: '',
    sort: 'recent',
    language: '',
    archived: false,
  })
})

test('selects, persists, reorders, and advances multi-document tabs', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    const match = path.match(/^\/api\/document\/(a|b)$/)
    if (match) return json(doc(match[1]))
    if (path.match(/^\/api\/document\/(a|b)\/versions$/)) return json([])
    throw new Error(`unexpected request ${path}`)
  }))

  await useDocumentsStore.getState().select('a')
  await useDocumentsStore.getState().select('b')
  useDocumentsStore.getState().moveTab('b', -1)
  expect(useDocumentsStore.getState().tabs).toEqual(['b', 'a'])
  expect(localStorage.getItem('next:document-tabs')).toBe('["b","a"]')

  useDocumentsStore.getState().close('b')
  await vi.waitFor(() => {
    expect(useDocumentsStore.getState()).toMatchObject({ selected: 'a', tabs: ['a'] })
    expect(useDocumentsStore.getState().document).toMatchObject({ status: 'ready', data: { id: 'a' } })
  })
  vi.unstubAllGlobals()
})

test('applies library filters and creates a selected document', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    paths.push(path)
    if (path === '/api/document' && init?.method === 'POST') return json(doc('new'))
    if (path.startsWith('/api/documents/library?')) return json(library([doc('new')]))
    if (path === '/api/document/new') return json(doc('new'))
    if (path === '/api/document/new/versions') return json([])
    throw new Error(`unexpected request ${path}`)
  }))

  await useDocumentsStore.getState().setFilters({ query: 'road map', sort: 'alpha', language: 'markdown', archived: true })
  expect(paths[0]).toBe('/api/documents/library?search=road%20map&sort=alpha&language=markdown&archived=true')
  await useDocumentsStore.getState().create('Road map')
  expect(useDocumentsStore.getState()).toMatchObject({ selected: 'new', tabs: ['new'], error: null })
  vi.unstubAllGlobals()
})

test('saves metadata, restores a version, and uses document archive state', async () => {
  const writes: Array<{ path: string; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (init?.method) writes.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (path.startsWith('/api/documents/library?')) return json(library())
    if (path === '/api/document/a' && init?.method === 'PUT') return json(doc('a', { title: 'Renamed', language: 'text', current_content: 'Changed', version_count: 2 }))
    if (path === '/api/document/a/restore/1') return json(doc('a', { current_content: 'Original', version_count: 3, archived: true }))
    if (path === '/api/document/a' && !init?.method) return json(doc('a', { current_content: 'Original', version_count: 3, archived: true }))
    if (path === '/api/document/a/versions') return json([{ version: 2, updated_at: 'now' }])
    if (path === '/api/document/a/archive?archived=false') return json(doc('a', { archived: false }))
    throw new Error(`unexpected request ${path}`)
  }))
  useDocumentsStore.setState({
    selected: 'a',
    tabs: ['a'],
    document: { status: 'ready', data: doc('a', { archived: true }), fetchedAt: Date.now() },
  })

  await useDocumentsStore.getState().save('Changed', 'Renamed', 'text')
  expect(writes[0]).toEqual({ path: '/api/document/a', body: { content: 'Changed', title: 'Renamed', language: 'text' } })
  await useDocumentsStore.getState().restore(1)
  expect(useDocumentsStore.getState().document).toMatchObject({ status: 'ready', data: { current_content: 'Original' } })
  await useDocumentsStore.getState().archive()
  expect(writes.some(write => write.path === '/api/document/a/archive?archived=false')).toBe(true)
  vi.unstubAllGlobals()
})

test('keeps a failed save visible without replacing the open document', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('disk full', { status: 500 })))
  useDocumentsStore.setState({
    selected: 'a',
    document: { status: 'ready', data: doc('a'), fetchedAt: Date.now() },
  })
  await useDocumentsStore.getState().save('Changed', 'Document a')
  expect(useDocumentsStore.getState()).toMatchObject({ saveState: 'failed' })
  expect(useDocumentsStore.getState().error).toContain('HTTP 500')
  expect(useDocumentsStore.getState().document).toMatchObject({ status: 'ready', data: { current_content: 'Body a' } })
  vi.unstubAllGlobals()
})
