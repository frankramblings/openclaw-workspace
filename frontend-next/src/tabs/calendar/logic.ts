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

