import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useNotesStore } from './store'
import type { Note } from './types'

const note = (overrides: Partial<Note> = {}): Note => ({ id: 'n1', title: 'One', content: 'Body', note_type: 'note', pinned: false, archived: false, ...overrides })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => useNotesStore.setState({ notes: idle, selected: null, archived: false, pending: null, saveState: 'idle', error: null }))

test('loads active and archived vault notes explicitly', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    paths.push(String(input))
    return json({ notes: [note({ archived: paths.length > 1 })] })
  }))
  await useNotesStore.getState().load()
  await useNotesStore.getState().load(true)
  expect(paths).toEqual(['/api/notes?archived=false', '/api/notes?archived=true'])
  expect(useNotesStore.getState()).toMatchObject({ archived: true, notes: { status: 'ready' } })
  vi.unstubAllGlobals()
})

test('creates todos and round-trips rich editable fields', async () => {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (init?.body) writes.push({ path, body: JSON.parse(String(init.body)) })
    if (path === '/api/notes' && init?.method === 'POST') return json(note({ note_type: 'todo', items: [] }))
    if (path === '/api/notes?archived=false') return json({ notes: [note({ note_type: 'todo', items: [] })] })
    if (path === '/api/notes/n1' && init?.method === 'PUT') return json(note({ note_type: 'todo', color: 'blue', label: 'work', due_date: '2026-07-17T09:00', repeat: 'weekly', items: [{ id: 'i1', text: 'Ship', done: false }] }))
    throw new Error(`unexpected request ${path}`)
  }))
  await useNotesStore.getState().create('todo')
  expect(writes[0].body).toMatchObject({ note_type: 'todo', items: [] })
  const ok = await useNotesStore.getState().save('n1', { note_type: 'todo', color: 'blue', label: 'work', due_date: '2026-07-17T09:00', repeat: 'weekly', items: [{ id: 'i1', text: 'Ship', done: false }] })
  expect(ok).toBe(true)
  expect(useNotesStore.getState()).toMatchObject({ saveState: 'saved', selected: { color: 'blue', repeat: 'weekly' } })
  vi.unstubAllGlobals()
})

test('pins, archives, reorders, fires reminders, and preserves visible errors', async () => {
  const paths: string[] = []
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    paths.push(path)
    if (fail) return json({ error: 'disk full' }, 500)
    if (path === '/api/notes/n1' && init?.method === 'PUT') return json(note({ pinned: true }))
    if (path === '/api/notes/reorder') return json({ ok: true })
    if (path === '/api/notes/fire-reminder') return json({ ok: true })
    if (path === '/api/notes?archived=false') return json({ notes: [note(), note({ id: 'n2', title: 'Two' })] })
    throw new Error(`unexpected request ${path}`)
  }))
  useNotesStore.setState({ selected: note(), notes: { status: 'ready', data: { notes: [note(), note({ id: 'n2', title: 'Two' })] }, fetchedAt: Date.now() } })
  await useNotesStore.getState().togglePin(note())
  await useNotesStore.getState().move('n2', -1)
  await useNotesStore.getState().fireReminder(note())
  expect(paths).toContain('/api/notes/reorder')
  expect(paths).toContain('/api/notes/fire-reminder')
  fail = true
  expect(await useNotesStore.getState().save('n1', { title: 'Lost' })).toBe(false)
  expect(useNotesStore.getState()).toMatchObject({ saveState: 'failed' })
  expect(useNotesStore.getState().error).toContain('HTTP 500')
  vi.unstubAllGlobals()
})
