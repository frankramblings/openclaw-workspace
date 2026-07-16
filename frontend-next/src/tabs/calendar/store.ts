import { create } from 'zustand'
import { ApiError, apiDelete, apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import { isoDay, monthWindow } from './logic'
import type { CalendarEvent, CalendarsResponse, EventsResponse } from './types'

interface CalendarState {
  calendars: Remote<CalendarsResponse>
  events: Remote<EventsResponse>
  offset: number
  parsed: Remote<CalendarEvent>
  sync: Remote<{ ok: boolean }>
  pending: string | null
  error: string | null
  load(offset?: number): Promise<void>
  shift(delta: number): Promise<void>
  quick(text: string): Promise<void>
  save(event: Partial<CalendarEvent>): Promise<boolean>
  remove(event: CalendarEvent): Promise<boolean>
  syncNow(): Promise<void>
  importIcs(content: string): Promise<number | null>
}

const calLoader = makeLoader<CalendarsResponse>()
const eventLoader = makeLoader<EventsResponse>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export const useCalendarStore = create<CalendarState>((set, get) => {
  const load = async (offset = get().offset) => {
    const window = monthWindow(new Date(), offset)
    set({ offset })
    await Promise.all([
      calLoader(() => apiGet('/api/calendar/calendars'), calendars => set({ calendars }), get().calendars),
      eventLoader(() => apiGet(`/api/calendar/events?start=${isoDay(window.fetchStart)}&end=${isoDay(window.fetchEnd)}`), events => set({ events }), get().events),
    ])
  }
  return {
    calendars: idle,
    events: idle,
    parsed: idle,
    sync: idle,
    offset: 0,
    pending: null,
    error: null,
    load,
    shift: delta => load(get().offset + delta),
    quick: async text => {
      if (!text.trim()) return
      set({ parsed: { status: 'loading' }, error: null })
      try {
        const data = await apiJson<CalendarEvent>('POST', '/api/calendar/quick-parse', { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
        set({ parsed: { status: 'ready', data, fetchedAt: Date.now() } })
      } catch (error) {
        set({ parsed: { status: 'error', error: message(error), ...(error instanceof ApiError ? { httpStatus: error.status } : {}) } })
      }
    },
    save: async event => {
      set({ pending: event.uid || 'new', error: null })
      try {
        const path = event.uid ? `/api/calendar/events/${encodeURIComponent(event.uid)}` : '/api/calendar/events'
        await apiJson(event.uid ? 'PUT' : 'POST', path, event)
        await load()
        set({ parsed: idle })
        return true
      } catch (error) {
        set({ error: message(error) })
        return false
      } finally {
        set({ pending: null })
      }
    },
    remove: async event => {
      set({ pending: event.uid, error: null })
      try {
        await apiDelete(`/api/calendar/events/${encodeURIComponent(event.uid)}?calendar=${encodeURIComponent(event.calendar_href || event.calendar || '')}`)
        await load()
        return true
      } catch (error) {
        set({ error: message(error) })
        return false
      } finally {
        set({ pending: null })
      }
    },
    syncNow: async () => {
      set({ sync: { status: 'loading' }, error: null })
      try {
        const data = await apiJson<{ ok: boolean }>('POST', '/api/calendar/sync')
        set({ sync: { status: 'ready', data, fetchedAt: Date.now() } })
        await load()
      } catch (error) {
        set({ sync: { status: 'error', error: message(error) } })
      }
    },
    importIcs: async content => {
      set({ pending: 'import', error: null })
      try {
        const response = await fetch('/api/calendar/import', { method: 'POST', headers: { 'Content-Type': 'text/calendar' }, body: content })
        if (!response.ok) throw new ApiError(response.status, await response.text())
        const data = await response.json() as { imported: number }
        await load()
        return data.imported
      } catch (error) {
        set({ error: message(error) })
        return null
      } finally {
        set({ pending: null })
      }
    },
  }
})
