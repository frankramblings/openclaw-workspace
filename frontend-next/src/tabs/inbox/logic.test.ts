import { ageLabelFor, groupBySource, primaryActions, swipeOutcome } from './logic'
import type { InboxItem } from './types'

const item = (patch: Partial<InboxItem> = {}): InboxItem => ({ id: '1', source: 'gmail', title: 'Mail', score: 1, meta: {}, actions: ['archive'], ...patch })

test('ages use source timestamps and handle future events', () => {
  const now = Date.parse('2026-07-16T12:00:00Z')
  expect(ageLabelFor(item({ meta: { receivedAt: now - 3 * 3_600_000 } }), now)).toBe('3h')
  expect(ageLabelFor(item({ source: 'calendar', meta: { start: now + 2 * 3_600_000 } }), now)).toBe('in 2h')
  expect(ageLabelFor(item({ source: 'entities', ts: now }), now)).toBe('—')
})

test('touch gestures require horizontal intent and commit by direction', () => {
  expect(swipeOutcome(120, 15)).toBe('primary')
  expect(swipeOutcome(-120, 15)).toBe('dismiss')
  expect(swipeOutcome(80, 5)).toBeNull()
  expect(swipeOutcome(120, 150)).toBeNull()
})

test('groups by source and derives only server-offered actions', () => {
  expect(groupBySource([item(), item({ id: '2' }), item({ id: '3', source: 'slack' })]).map(([source, rows]) => [source, rows.length])).toEqual([['gmail', 2], ['slack', 1]])
  expect(primaryActions(item({ actions: ['dismiss', 'archive', 'delete'] }))).toEqual(['archive', 'delete'])
})
