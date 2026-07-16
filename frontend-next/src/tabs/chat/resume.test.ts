import { expect, test } from 'vitest'
import type { ChatEvent } from '../../api/events'
import { applyEvent, emptyTurn } from './reducer'
import { hydrateTurn, reconcileDecision } from './resume'

test('reconcile decision attaches only when the local source is absent or stale', () => {
  expect(reconcileDecision({ active: true, lastTurnStatus: null, hasLocalLive: false, localSessionMatches: true })).toBe('attach')
  expect(reconcileDecision({ active: true, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: true, localFresh: true })).toBe('none')
  expect(reconcileDecision({ active: true, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: true, localFresh: false })).toBe('attach')
  expect(reconcileDecision({ active: false, lastTurnStatus: 'interrupted', hasLocalLive: true, localSessionMatches: true })).toBe('finalize-interrupted')
  expect(reconcileDecision({ active: false, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: false })).toBe('none')
})

test('snapshot replay produces the same turn as direct events', () => {
  const events: ChatEvent[] = [
    { type: 'turn_start', turn_id: 9, session_key: 'agent:main:web-one', ts: 1 },
    { type: 'text', delta: 'Hello', thinking: false },
    { type: 'tool_start', tool: 'bash', tool_id: 't', command: 'pwd' },
    { type: 'tool_output', tool: 'bash', tool_id: 't', output: '/tmp', exit_code: 0 },
  ]
  const direct = events.reduce(applyEvent, emptyTurn())
  const stored = events.map((event, index) => ({ id: String(index + 1), data: `data: ${JSON.stringify(event)}\n\n` }))
  expect(hydrateTurn(stored)).toEqual(direct)
})
