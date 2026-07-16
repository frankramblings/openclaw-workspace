import { useEffect, useMemo, useState } from 'react'
import { Button, Card, EmptyState, Modal, RemoteView, SectionHeader } from '../../kit'
import { addDays, eventDays, isoDay, localDateTime, mondayIndex, monthWindow, withLocalOffset } from './logic'
import { useCalendarStore } from './store'
import type { CalendarEvent } from './types'
import { WeekView } from './WeekView'

type View = 'month' | 'week' | 'agenda'
const blankEvent = (): Partial<CalendarEvent> => {
  const start = new Date(); start.setHours(start.getHours() + 1, 0, 0, 0)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  return { summary: '', dtstart: localDateTime(start.toISOString()), dtend: localDateTime(end.toISOString()), all_day: false, location: '', description: '', rrule: '' }
}
const editEvent = (event: Partial<CalendarEvent>): Partial<CalendarEvent> => ({ ...event, dtstart: event.all_day ? event.dtstart?.slice(0, 10) : localDateTime(event.dtstart ?? ''), dtend: event.all_day ? event.dtend?.slice(0, 10) : localDateTime(event.dtend ?? '') })
const timeLabel = (event: CalendarEvent) => event.all_day ? 'All day' : new Date(event.dtstart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function EventModal({ event, close }: { event: Partial<CalendarEvent>; close(): void }) {
  const store = useCalendarStore()
  const [draft, setDraft] = useState(() => editEvent(event))
  const save = async () => {
    const calendar = draft.calendar_href || draft.calendar || (store.calendars.status === 'ready' ? store.calendars.data.calendars.find(item => item.primary)?.href || store.calendars.data.calendars[0]?.href : '')
    const payload = { ...draft, calendar, calendar_href: calendar, dtstart: draft.all_day ? draft.dtstart?.slice(0, 10) : withLocalOffset(draft.dtstart ?? ''), dtend: draft.all_day ? draft.dtend?.slice(0, 10) : withLocalOffset(draft.dtend ?? '') }
    if (await store.save(payload)) close()
  }
  return <Modal open onClose={close} title={draft.uid ? 'Edit event' : 'Create event'}><div className="next-calendar-form">
    <label>Title<input autoFocus value={draft.summary ?? ''} onChange={event => setDraft({ ...draft, summary: event.target.value })} /></label>
    <label className="next-calendar-allday"><input type="checkbox" checked={Boolean(draft.all_day)} onChange={event => setDraft({ ...draft, all_day: event.target.checked, dtstart: event.target.checked ? draft.dtstart?.slice(0, 10) : `${draft.dtstart?.slice(0, 10)}T09:00`, dtend: event.target.checked ? draft.dtend?.slice(0, 10) : `${draft.dtend?.slice(0, 10)}T10:00` })} /> All day</label>
    <div><label>Starts<input type={draft.all_day ? 'date' : 'datetime-local'} value={draft.dtstart ?? ''} onChange={event => setDraft({ ...draft, dtstart: event.target.value })} /></label><label>Ends<input type={draft.all_day ? 'date' : 'datetime-local'} value={draft.dtend ?? ''} onChange={event => setDraft({ ...draft, dtend: event.target.value })} /></label></div>
    <label>Calendar<select value={draft.calendar_href || draft.calendar || ''} onChange={event => setDraft({ ...draft, calendar_href: event.target.value, calendar: event.target.value })}><option value="">Default calendar</option>{store.calendars.status === 'ready' && store.calendars.data.calendars.map(calendar => <option key={calendar.href} value={calendar.href}>{calendar.name}</option>)}</select></label>
    <label>Location<input value={draft.location ?? ''} onChange={event => setDraft({ ...draft, location: event.target.value })} /></label>
    <label>Description<textarea value={draft.description ?? ''} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
    <label>Repeat<select value={draft.rrule ?? ''} onChange={event => setDraft({ ...draft, rrule: event.target.value })}><option value="">Does not repeat</option><option value="FREQ=DAILY">Daily</option><option value="FREQ=WEEKLY">Weekly</option><option value="FREQ=MONTHLY">Monthly</option><option value="FREQ=YEARLY">Yearly</option></select></label>
    <div className="next-calendar-form-actions">{draft.uid && <Button variant="danger" disabled={store.pending === draft.uid} onClick={() => { if (confirm('Delete this event?')) void store.remove(draft as CalendarEvent).then(ok => { if (ok) close() }) }}>Delete</Button>}<span /> <Button variant="ghost" onClick={close}>Cancel</Button><Button disabled={!draft.summary?.trim() || Boolean(store.pending)} onClick={() => void save()}>Save</Button></div>
  </div></Modal>
}

export function CalendarTab() {
  const store = useCalendarStore()
  const [quick, setQuick] = useState('')
  const [editing, setEditing] = useState<Partial<CalendarEvent> | null>(null)
  const [view, setViewState] = useState<View>(() => (typeof window.matchMedia === 'function' && window.matchMedia('(max-width:760px)').matches) ? 'agenda' : (localStorage.getItem('next:calendar-view') as View || 'month'))
  const [hidden, setHidden] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('next:calendar-hidden') || '[]') as string[]) } catch { return new Set() } })
  const [imported, setImported] = useState<number | null>(null)
  const [weekAnchor, setWeekAnchor] = useState(() => new Date())
  useEffect(() => { void store.load() }, [])
  const calendarWindow = monthWindow(new Date(), store.offset)
  const events = store.events.status === 'ready' ? store.events.data.events : []
  const visible = useMemo(() => events.filter(event => !hidden.has(event.calendar_href || event.calendar || '')), [events, hidden])
  const byDay = useMemo(() => { const result: Record<string, CalendarEvent[]> = {}; for (const event of visible) for (const day of eventDays(event.dtstart, event.dtend, event.all_day)) (result[day] ??= []).push(event); for (const rows of Object.values(result)) rows.sort((a, b) => a.dtstart.localeCompare(b.dtstart)); return result }, [visible])
  const setView = (next: View) => { setViewState(next); localStorage.setItem('next:calendar-view', next) }
  const toggleCalendar = (href: string) => setHidden(current => { const next = new Set(current); next.has(href) ? next.delete(href) : next.add(href); localStorage.setItem('next:calendar-hidden', JSON.stringify([...next])); return next })
  const days = Array.from({ length: Math.round((calendarWindow.gridEnd.getTime() - calendarWindow.gridStart.getTime()) / 86_400_000) + 1 }, (_, index) => addDays(calendarWindow.gridStart, index))
  const weekStart = addDays(weekAnchor, -mondayIndex(weekAnchor)), weekDays = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
  const shift = (delta: number) => { if (view !== 'week') { void store.shift(delta); return } const next = addDays(weekAnchor, delta * 7), start = addDays(next, -mondayIndex(next)); setWeekAnchor(next); void store.loadRange(isoDay(start), isoDay(addDays(start, 7))) }
  const today = () => { if (view !== 'week') { void store.load(0); return } const next = new Date(), start = addDays(next, -mondayIndex(next)); setWeekAnchor(next); void store.loadRange(isoDay(start), isoDay(addDays(start, 7))) }
  return <main className="next-tab next-calendar-tab"><SectionHeader title="Calendar" actions={<><Button variant="ghost" onClick={() => shift(-1)}>Previous</Button><Button variant="ghost" onClick={today}>Today</Button><Button variant="ghost" onClick={() => shift(1)}>Next</Button><Button onClick={() => setEditing(blankEvent())}>New event</Button></>} />
    {store.error && <div className="next-inline-error" role="alert">{store.error}</div>}
    <Card><div className="next-calendar-toolbar"><strong>{view === 'week' ? `${weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : calendarWindow.first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong><div><Button variant={view === 'month' ? 'primary' : 'ghost'} onClick={() => setView('month')}>Month</Button><Button variant={view === 'week' ? 'primary' : 'ghost'} onClick={() => { setView('week'); void store.loadRange(isoDay(weekStart), isoDay(addDays(weekStart, 7))) }}>Week</Button><Button variant={view === 'agenda' ? 'primary' : 'ghost'} onClick={() => setView('agenda')}>Agenda</Button></div><form onSubmit={event => { event.preventDefault(); void store.quick(quick) }}><input aria-label="Quick add" value={quick} onChange={event => setQuick(event.target.value)} placeholder="Lunch Friday at noon" /><Button type="submit" disabled={!quick.trim()}>Parse</Button></form><Button variant="ghost" onClick={() => void store.syncNow()}>Sync</Button><label className="btn btn-ghost">Import ICS<input hidden type="file" accept=".ics,text/calendar" onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(content => store.importIcs(content)).then(setImported) }} /></label>{imported !== null && <small>{imported} imported</small>}</div>
      <RemoteView remote={store.calendars}>{data => <div className="next-calendar-filters">{data.error && <span className="next-error">{data.error}</span>}{data.calendars.map(calendar => <label key={calendar.href}><input type="checkbox" checked={!hidden.has(calendar.href)} onChange={() => toggleCalendar(calendar.href)} /><span style={{ background: calendar.color }} />{calendar.name}</label>)}</div>}</RemoteView>
    </Card>
    <RemoteView remote={store.parsed}>{event => <Card title="Parsed event"><p>{event.summary} · {event.dtstart}</p><Button onClick={() => setEditing(event)}>Review & create</Button></Card>}</RemoteView>
    <RemoteView remote={store.events} onRetry={store.load}>{data => <>{data.error && <div className="next-inline-error">{data.error}</div>}{view === 'month' ? <Card className="next-calendar-month"><div className="next-calendar-weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span key={day}>{day}</span>)}</div><div className="next-calendar-grid">{days.map(day => { const key = isoDay(day), rows = byDay[key] ?? []; return <section key={key} className={`${key === isoDay(calendarWindow.today) ? 'is-today ' : ''}${day.getMonth() === calendarWindow.first.getMonth() ? '' : 'is-outside'}`}><strong>{day.getDate()}</strong>{rows.slice(0, 4).map(event => <button key={`${event.calendar_href}:${event.uid}`} style={{ borderLeftColor: event.color }} onClick={() => setEditing(event)}><span>{timeLabel(event)}</span>{event.summary}</button>)}{rows.length > 4 && <small>+{rows.length - 4} more</small>}</section> })}</div></Card> : view === 'week' ? <WeekView days={weekDays} events={visible} pending={store.pending} onEdit={setEditing} onSave={store.save} /> : <Card title="Agenda"><div className="next-calendar-agenda">{days.map(day => { const key = isoDay(day), rows = byDay[key] ?? []; return <section key={key} className={key === isoDay(calendarWindow.today) ? 'is-today' : ''}><h3>{day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}{key === isoDay(calendarWindow.today) && <span>Today</span>}</h3><div>{rows.length ? rows.map(event => <button key={`${event.calendar_href}:${event.uid}`} onClick={() => setEditing(event)}><i style={{ background: event.color }} /><time>{timeLabel(event)}</time><span><strong>{event.summary}</strong>{event.location && <small>{event.location}</small>}</span></button>) : <p>No events</p>}</div></section> })}</div></Card>}{visible.length === 0 && <EmptyState title="No visible events in this window" />}</>}</RemoteView>
    {editing && <EventModal event={editing} close={() => setEditing(null)} />}
  </main>
}
