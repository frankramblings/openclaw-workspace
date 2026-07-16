import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useWorkspaceStore } from './store'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  useWorkspaceStore.setState({ open: false, rootKey: 'workspace', roots: idle, tree: idle, file: idle, selectedPath: null, error: null, pending: null })
  localStorage.clear()
})

test('loads the tree, edits with an mtime guard, and publishes the saved mtime', async () => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/workspace/roots') return json({ roots: [{ key: 'workspace', path: '/tmp/ws', available: true, mutable: true }] })
    if (path.startsWith('/api/workspace/tree')) return json({ root: '/tmp/ws', root_key: 'workspace', branch: 'main', dirty: false, tree: [{ name: 'note.md', path: 'note.md', type: 'file', size: 4 }], truncated: false, missing: false, mutable: true })
    if (path.startsWith('/api/workspace/file?') && !init?.method) return new Response('old', { headers: { 'x-mtime-ns': '12' } })
    if (path === '/api/workspace/file' && init?.method === 'PUT') { writes.push(JSON.parse(String(init.body))); return json({ ok: true, mtime_ns: 20 }) }
    throw new Error(`unexpected request ${path}`)
  }))
  await useWorkspaceStore.getState().load()
  await useWorkspaceStore.getState().openPath('note.md')
  useWorkspaceStore.getState().updateContent('new')
  expect(await useWorkspaceStore.getState().save()).toBe(true)
  expect(writes).toEqual([{ path: 'note.md', content: 'new', if_mtime_ns: 12 }])
  expect(useWorkspaceStore.getState().file).toMatchObject({ status: 'ready', data: { content: 'new', dirty: false, mtime: 20 } })
  vi.unstubAllGlobals()
})
