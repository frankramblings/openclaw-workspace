export function addDays(date: Date, count: number): Date { const next = new Date(date.getFullYear(), date.getMonth(), date.getDate()); next.setDate(next.getDate() + count); return next }
export function mondayIndex(date: Date): number { return (date.getDay() + 6) % 7 }
export function monthWindow(real: Date, offset = 0) {
  const today = new Date(real.getFullYear(), real.getMonth(), real.getDate())
  const first = new Date(real.getFullYear(), real.getMonth() + Math.trunc(offset), 1)
  const gridStart = addDays(first, -mondayIndex(first))
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = Math.ceil((mondayIndex(first) + days) / 7) * 7
  const gridEnd = addDays(gridStart, cells - 1)
  return { today, first, gridStart, gridEnd, fetchStart: gridStart < today ? gridStart : today, fetchEnd: addDays(gridEnd, 1) }
}
export function isoDay(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export function eventDays(start: string, end: string, allDay: boolean): string[] {
  const first = start.slice(0, 10)
  const last = (end || start).slice(0, 10)
  const cursor = new Date(`${first}T12:00:00`)
  const finish = new Date(`${last}T12:00:00`)
  const days: string[] = []
  while (cursor <= finish) {
    // All-day APIs conventionally use an exclusive DTEND. Preserve a
    // zero-duration single-day event, but don't paint the exclusive end day.
    if (!(allDay && first !== last && cursor.getTime() === finish.getTime())) days.push(isoDay(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days.length ? days : [first]
}
export function localDateTime(value: string): string {
  if (!value || value.length <= 10) return value
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value.slice(0, 16)
  return `${isoDay(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
export function withLocalOffset(value: string): string {
  if (!value || value.length <= 10 || /(?:Z|[+-]\d\d:\d\d)$/.test(value)) return value
  const offset = -new Date(value).getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return `${value.length === 16 ? `${value}:00` : value}${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}
