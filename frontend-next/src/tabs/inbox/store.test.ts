import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useInboxStore } from './store'
import type { InboxItem, ItemsResponse } from './types'

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({ id: '1', source: 'gmail', title: 'Mail', subtitle: 'Sender', snippet: 'Body', score: 10, meta: { uid: '1' }, actions: ['archive', 'snooze', 'dismiss'], ...overrides })
const feed = (items = [item()]): ItemsResponse => ({ items, total: items.length, sources: { gmail: items.length }, errors: {}, generatedAt: 1000 })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => useInboxStore.setState({ feed: idle, history: idle, detail: idle, selected: null, pendingKey: null, selection: [], error: null, notice: null, triaging: false }))

test('loads feed/history and reads supported sources in place', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); paths.push(path)
    if (path === '/api/items') return json(feed())
    if (path === '/api/items/history?limit=20') return json({ entries: [] })
    if (path === '/api/email/read/1?mark_seen=false') return json({ subject: 'Mail', body: 'Hello' })
    if (path.startsWith('/api/inbox/slack/thread?')) return json({ messages: [{ text: 'Thread' }] })
    if (path === '/api/inbox/asana/task?gid=a1') return json({ name: 'Task' })
    throw new Error(`unexpected request ${path}`)
  }))
  await useInboxStore.getState().load()
  await useInboxStore.getState().select(item())
  expect(useInboxStore.getState().detail).toMatchObject({ status: 'ready', data: { subject: 'Mail' } })
  await useInboxStore.getState().select(item({ id: 's1', source: 'slack', meta: { channelId: 'c1', threadTs: 't1' } }))
  await useInboxStore.getState().select(item({ id: 'a1', source: 'asana', meta: {} }))
  expect(paths).toEqual(expect.arrayContaining(['/api/email/read/1?mark_seen=false', '/api/inbox/slack/thread?channel_id=c1&thread_ts=t1', '/api/inbox/asana/task?gid=a1']))
  vi.unstubAllGlobals()
})

test('snoozes with a required deadline, removes the card, and exposes undo', async () => {
  let actionBody: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/items/action') { actionBody = JSON.parse(String(init?.body)); return json({ ok: true, undoTs: 42 }) }
    if (path === '/api/items/history?limit=20') return json({ entries: [] })
    if (path === '/api/items/undo') return json({ ok: true })
    if (path === '/api/items') return json(feed())
    throw new Error(`unexpected request ${path}`)
  }))
  useInboxStore.setState({ feed: { status: 'ready', data: feed(), fetchedAt: Date.now() }, selected: item() })
  expect(await useInboxStore.getState().act(item(), 'snooze', { until: 9999 })).toBe(true)
  expect(actionBody).toMatchObject({ source: 'gmail', id: '1', action: 'snooze', until: 9999 })
  expect(useInboxStore.getState()).toMatchObject({ selected: null, notice: { undoTs: 42 }, feed: { data: { total: 0, items: [] } } })
  expect(await useInboxStore.getState().undo(42)).toBe(true)
  expect(useInboxStore.getState().feed).toMatchObject({ status: 'ready', data: { total: 1 } })
  vi.unstubAllGlobals()
})

test('supports RSVP/configured actions, bulk selection, handoff and visible failure', async () => {
  const bodies: Record<string, unknown>[] = []
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); if (init?.body) bodies.push(JSON.parse(String(init.body)))
    if (fail) return json({ error: 'remote failed' }, 502)
    if (path === '/api/items/action') return json({ ok: true })
    if (path === '/api/items/history?limit=20') return json({ entries: [] })
    if (path === '/api/items/spinoff') return json({ session_id: 'chat-1', count: 2 })
    throw new Error(`unexpected request ${path}`)
  }))
  const invite = item({ id: 'cal', source: 'calendar', actions: ['rsvp'], meta: {} })
  await useInboxStore.getState().act(invite, 'rsvp:accepted')
  expect(bodies[0]).toMatchObject({ action: 'rsvp', response: 'accepted' })
  useInboxStore.getState().toggleSelection(item())
  expect(useInboxStore.getState().selection).toEqual(['gmail:1'])
  expect(await useInboxStore.getState().spinoff([item(), invite])).toBe('chat-1')
  fail = true
  expect(await useInboxStore.getState().act(item(), 'archive')).toBe(false)
  expect(useInboxStore.getState().error).toContain('HTTP 502')
  vi.unstubAllGlobals()
})
