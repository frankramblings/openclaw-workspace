import { create } from 'zustand'
import { apiDelete, apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import { isoDay, monthWindow } from './logic'
import type { CalendarEvent, CalendarsResponse, EventsResponse } from './types'
interface CalendarState { calendars: Remote<CalendarsResponse>; events: Remote<EventsResponse>; offset: number; parsed: Remote<CalendarEvent>; sync: Remote<{ ok: boolean }>; load(offset?: number): Promise<void>; shift(delta: number): Promise<void>; quick(text: string): Promise<void>; save(event: Partial<CalendarEvent>): Promise<void>; remove(event: CalendarEvent): Promise<void>; syncNow(): Promise<void> }
const calLoader = makeLoader<CalendarsResponse>(), eventLoader = makeLoader<EventsResponse>()
export const useCalendarStore = create<CalendarState>((set, get) => {
  const load = async (offset = get().offset) => { const w = monthWindow(new Date(), offset); set({ offset }); await Promise.all([calLoader(() => apiGet('/api/calendar/calendars'), (calendars) => set({ calendars }), get().calendars), eventLoader(() => apiGet(`/api/calendar/events?start=${isoDay(w.fetchStart)}&end=${isoDay(w.fetchEnd)}`), (events) => set({ events }), get().events)]) }
  return { calendars: idle, events: idle, parsed: idle, sync: idle, offset: 0, load, shift: async (delta) => load(get().offset + delta),
    quick: async (text) => { set({ parsed: { status: 'loading' } }); try { const data = await apiJson<CalendarEvent>('POST', '/api/calendar/quick-parse', { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); set({ parsed: { status: 'ready', data, fetchedAt: Date.now() } }) } catch (e) { set({ parsed: { status: 'error', error: e instanceof Error ? e.message : String(e) } }) } },
    save: async (event) => { if (event.uid) await apiJson('PUT', `/api/calendar/events/${encodeURIComponent(event.uid)}`, event); else await apiJson('POST', '/api/calendar/events', event); await load() },
    remove: async (event) => { await apiDelete(`/api/calendar/events/${encodeURIComponent(event.uid)}?calendar=${encodeURIComponent(event.calendar ?? '')}`); await load() },
    syncNow: async () => { set({ sync: { status: 'loading' } }); try { const data = await apiJson<{ ok: boolean }>('POST', '/api/calendar/sync'); set({ sync: { status: 'ready', data, fetchedAt: Date.now() } }); await load() } catch (e) { set({ sync: { status: 'error', error: e instanceof Error ? e.message : String(e) } }) } },
  }
})

