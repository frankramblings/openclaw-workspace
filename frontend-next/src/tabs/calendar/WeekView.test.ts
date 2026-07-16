import { expect, test } from 'vitest'
import { moveWeekEvent, resizeWeekEvent } from './WeekView'
import type { CalendarEvent } from './types'

const event: CalendarEvent = { uid: 'one', summary: 'Review', dtstart: '2026-07-16T10:00:00-04:00', dtend: '2026-07-16T11:00:00-04:00', all_day: false }

test('week drag changes day/time while preserving duration', () => {
  const moved = moveWeekEvent(event, new Date(2026, 6, 20), 9 * 60 + 30)
  expect(moved.dtstart).toContain('2026-07-20T09:30')
  expect(new Date(moved.dtend!).getTime() - new Date(moved.dtstart!).getTime()).toBe(60 * 60_000)
})

test('week resize snaps to 15 minutes and never crosses start', () => {
  const longer = resizeWeekEvent(event, 32)
  expect(new Date(longer.dtend!).getTime() - new Date(longer.dtstart!).getTime()).toBe(90 * 60_000)
  const minimum = resizeWeekEvent(event, -500)
  expect(new Date(minimum.dtend!).getTime() - new Date(minimum.dtstart!).getTime()).toBe(15 * 60_000)
})
