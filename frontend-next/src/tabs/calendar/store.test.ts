import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useCalendarStore } from './store'
import type { CalendarEvent } from './types'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const event: CalendarEvent = { uid: 'e1', summary: 'Review', dtstart: '2026-07-16T10:00:00-04:00', dtend: '2026-07-16T11:00:00-04:00', all_day: false, calendar: 'personal' }

beforeEach(() => useCalendarStore.setState({ calendars: idle, events: idle, parsed: idle, sync: idle, offset: 0, pending: null, error: null }))

test('loads a server-derived month window and shifts it', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); paths.push(path)
    return path === '/api/calendar/calendars' ? json({ calendars: [] }) : json({ events: [] })
  }))
  await useCalendarStore.getState().load(0)
  await useCalendarStore.getState().shift(1)
  expect(paths.some(path => /^\/api\/calendar\/events\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}$/.test(path))).toBe(true)
  expect(useCalendarStore.getState().offset).toBe(1)
  vi.unstubAllGlobals()
})

test('parses quick add and performs calendar-aware create, update and delete', async () => {
  const writes: Array<{ method?: string; path: string; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); if (init?.method) writes.push({ method: init.method, path, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (path === '/api/calendar/quick-parse') return json(event)
    if (path === '/api/calendar/events' && init?.method === 'POST') return json(event)
    if (path === '/api/calendar/events/e1' && init?.method === 'PUT') return json(event)
    if (path === '/api/calendar/events/e1?calendar=personal' && init?.method === 'DELETE') return json({ ok: true })
    if (path === '/api/calendar/calendars') return json({ calendars: [] })
    if (path.startsWith('/api/calendar/events?')) return json({ events: [event] })
    throw new Error(`unexpected request ${path}`)
  }))
  await useCalendarStore.getState().quick('review tomorrow at ten')
  expect(useCalendarStore.getState().parsed).toMatchObject({ status: 'ready', data: { uid: 'e1' } })
  expect(await useCalendarStore.getState().save({ ...event, uid: undefined, calendar: 'personal' })).toBe(true)
  expect(await useCalendarStore.getState().save(event)).toBe(true)
  expect(await useCalendarStore.getState().remove(event)).toBe(true)
  expect(writes.map(write => `${write.method} ${write.path}`)).toEqual(expect.arrayContaining(['POST /api/calendar/events', 'PUT /api/calendar/events/e1', 'DELETE /api/calendar/events/e1?calendar=personal']))
  vi.unstubAllGlobals()
})

test('imports ICS and keeps mutation failures visible', async () => {
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (fail) return json({ error: 'provider down' }, 502)
    if (path === '/api/calendar/import') return json({ ok: true, imported: 2 })
    if (path === '/api/calendar/calendars') return json({ calendars: [] })
    if (path.startsWith('/api/calendar/events?')) return json({ events: [] })
    throw new Error(`unexpected request ${path}`)
  }))
  expect(await useCalendarStore.getState().importIcs('BEGIN:VCALENDAR')).toBe(2)
  fail = true
  expect(await useCalendarStore.getState().remove(event)).toBe(false)
  expect(useCalendarStore.getState().error).toContain('HTTP 502')
  vi.unstubAllGlobals()
})
