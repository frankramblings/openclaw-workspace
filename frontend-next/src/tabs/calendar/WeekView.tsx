import { useState, type DragEvent, type PointerEvent } from 'react'
import { Card } from '../../kit'
import { isoDay, localDateTime, withLocalOffset } from './logic'
import type { CalendarEvent } from './types'

const PX_PER_MINUTE = 0.8
const DAY_HEIGHT = 24 * 60 * PX_PER_MINUTE
const snap = (minutes: number) => Math.max(0, Math.min(23 * 60 + 45, Math.round(minutes / 15) * 15))
const wireDate = (date: Date) => withLocalOffset(localDateTime(date.toISOString()))

export function moveWeekEvent(event: CalendarEvent, day: Date, minutes: number): Partial<CalendarEvent> {
  if (event.all_day) {
    const duration = Math.max(1, Math.round((new Date(`${event.dtend.slice(0, 10)}T12:00`).getTime() - new Date(`${event.dtstart.slice(0, 10)}T12:00`).getTime()) / 86_400_000))
    const end = new Date(day); end.setDate(end.getDate() + duration)
    return { ...event, dtstart: isoDay(day), dtend: isoDay(end) }
  }
  const start = new Date(event.dtstart), end = new Date(event.dtend)
  const duration = Math.max(15 * 60_000, end.getTime() - start.getTime())
  const moved = new Date(day); moved.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return { ...event, dtstart: wireDate(moved), dtend: wireDate(new Date(moved.getTime() + duration)) }
}

export function resizeWeekEvent(event: CalendarEvent, deltaMinutes: number): Partial<CalendarEvent> {
  const start = new Date(event.dtstart), end = new Date(event.dtend)
  const duration = Math.max(15, Math.round((end.getTime() - start.getTime()) / 60_000) + Math.round(deltaMinutes / 15) * 15)
  return { ...event, dtend: wireDate(new Date(start.getTime() + duration * 60_000)) }
}

export function WeekView({ days, events, pending, onEdit, onSave }: { days: Date[]; events: CalendarEvent[]; pending: string | null; onEdit(event: CalendarEvent): void; onSave(event: Partial<CalendarEvent>): Promise<boolean> }) {
  const [resize, setResize] = useState<{ uid: string; delta: number } | null>(null)
  const timed = events.filter(event => !event.all_day && days.some(day => isoDay(day) === event.dtstart.slice(0, 10)))
  const allDay = events.filter(event => event.all_day && days.some(day => isoDay(day) >= event.dtstart.slice(0, 10) && isoDay(day) < event.dtend.slice(0, 10)))
  const beginResize = (pointer: PointerEvent, item: CalendarEvent) => {
    pointer.preventDefault(); pointer.stopPropagation()
    const origin = pointer.clientY
    const move = (next: globalThis.PointerEvent) => setResize({ uid: item.uid, delta: (next.clientY - origin) / PX_PER_MINUTE })
    const up = (next: globalThis.PointerEvent) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setResize(null); void onSave(resizeWeekEvent(item, (next.clientY - origin) / PX_PER_MINUTE)) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true })
  }
  const drop = (drag: DragEvent, day: Date) => {
    drag.preventDefault()
    const item = events.find(event => event.uid === drag.dataTransfer.getData('text/calendar-event'))
    if (!item) return
    const rect = drag.currentTarget.getBoundingClientRect()
    void onSave(moveWeekEvent(item, day, snap((drag.clientY - rect.top) / PX_PER_MINUTE)))
  }
  return <Card className="next-calendar-week"><div className="next-calendar-week-head"><span>Time</span>{days.map(day => <strong key={isoDay(day)}>{day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</strong>)}</div>{allDay.length > 0 && <div className="next-calendar-all-day"><span>All day</span>{days.map(day => <div key={isoDay(day)}>{allDay.filter(event => isoDay(day) >= event.dtstart.slice(0, 10) && isoDay(day) < event.dtend.slice(0, 10)).map(event => <button key={event.uid} onClick={() => onEdit(event)}>{event.summary}</button>)}</div>)}</div>}<div className="next-calendar-week-scroll"><div className="next-calendar-time-rail" style={{ height: DAY_HEIGHT }}>{Array.from({ length: 24 }, (_, hour) => <time key={hour} style={{ top: hour * 60 * PX_PER_MINUTE }}>{new Date(2020, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' })}</time>)}</div>{days.map(day => <div key={isoDay(day)} className="next-calendar-day-column" style={{ height: DAY_HEIGHT }} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, day)}>{timed.filter(event => event.dtstart.slice(0, 10) === isoDay(day)).map(event => { const start = new Date(event.dtstart), end = new Date(event.dtend); const top = (start.getHours() * 60 + start.getMinutes()) * PX_PER_MINUTE; const base = Math.max(24, (end.getTime() - start.getTime()) / 60_000 * PX_PER_MINUTE); const height = resize?.uid === event.uid ? Math.max(24, base + resize.delta * PX_PER_MINUTE) : base; return <article key={event.uid} className="next-calendar-week-event" draggable={pending !== event.uid} style={{ top, height, borderLeftColor: event.color }} onDragStart={drag => drag.dataTransfer.setData('text/calendar-event', event.uid)}><button onClick={() => onEdit(event)}><time>{start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><strong>{event.summary}</strong></button><button className="next-calendar-event-resize" aria-label={`Resize ${event.summary}`} onPointerDown={pointer => beginResize(pointer, event)} /></article> })}</div>)}</div></Card>
}
