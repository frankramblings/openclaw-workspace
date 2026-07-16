import { describe, expect, test } from 'vitest'
import type { ChatEvent } from '../../api/events'
import { applyEvent, emptyTurn, type Turn } from './reducer'

const reduce = (events: ChatEvent[], initial: Turn = emptyTurn()): Turn =>
  events.reduce(applyEvent, initial)

describe('applyEvent', () => {
  test('turn_start records the numeric turn id and starts streaming', () => {
    const turn = reduce([
      { type: 'turn_start', turn_id: 42, session_key: 'agent:main:web-a', ts: 100 },
    ])

    expect(turn.turnId).toBe(42)
    expect(turn.status).toBe('streaming')
  })

  test('text deltas append to prose or thinking on the active assistant bubble', () => {
    const turn = reduce([
      { type: 'text', delta: 'Let me ', thinking: true },
      { type: 'text', delta: 'check.', thinking: true },
      { type: 'text', delta: 'Done', thinking: false },
      { type: 'text', delta: '.', thinking: false },
    ])

    expect(turn.bubbles).toHaveLength(1)
    expect(turn.bubbles[0]).toMatchObject({ role: 'assistant', thinking: 'Let me check.', text: 'Done.' })
  })

  test('agent_step opens a fresh assistant bubble', () => {
    const turn = reduce([
      { type: 'text', delta: 'First', thinking: false },
      { type: 'agent_step' },
      { type: 'text', delta: 'Second', thinking: false },
    ])

    expect(turn.bubbles.map((bubble) => bubble.text)).toEqual(['First', 'Second'])
  })

  test('interleaved tool outputs pair with their tool ids', () => {
    const turn = reduce([
      { type: 'tool_start', tool: 'read', tool_id: 'a', command: 'one' },
      { type: 'tool_start', tool: 'bash', tool_id: 'b', command: 'two' },
      { type: 'tool_output', tool: 'read', tool_id: 'a', output: 'A', exit_code: 0 },
      { type: 'tool_output', tool: 'bash', tool_id: 'b', output: 'B', exit_code: 1 },
    ])

    expect(turn.bubbles[0].cards).toEqual([
      expect.objectContaining({ toolId: 'a', output: 'A', state: 'done', exitCode: 0 }),
      expect.objectContaining({ toolId: 'b', output: 'B', state: 'error', exitCode: 1 }),
    ])
  })

  test('reply_reset clears current assistant prose but preserves thinking and cards', () => {
    const turn = reduce([
      { type: 'text', delta: 'working', thinking: true },
      { type: 'tool_start', tool: 'bash', tool_id: 'tool-1', command: 'echo ok' },
      { type: 'text', delta: 'Sent it', thinking: false },
      { type: 'reply_reset' },
      { type: 'text', delta: 'Final reply', thinking: false },
    ])

    expect(turn.bubbles[0].text).toBe('Final reply')
    expect(turn.bubbles[0].thinking).toBe('working')
    expect(turn.bubbles[0].cards).toHaveLength(1)
  })

  test('stall state is cleared by the next text delta', () => {
    const stalled = reduce([{ type: 'stall', silent_for: 31 }])
    expect(stalled).toMatchObject({ status: 'stalled', stallSeconds: 31 })

    const resumed = applyEvent(stalled, { type: 'text', delta: 'back', thinking: false })
    expect(resumed.status).toBe('streaming')
    expect(resumed.stallSeconds).toBeUndefined()
  })

  test.each([
    ['ok', 'done'],
    ['error', 'error'],
    ['aborted', 'aborted'],
  ] as const)('turn_end maps %s to %s', (wireStatus, status) => {
    const turn = reduce([
      { type: 'turn_end', turn_id: 1, status: wireStatus, ts: 200 },
    ])
    expect(turn.status).toBe(status)
  })

  test('abort output creates the visible stop card', () => {
    const turn = reduce([
      { type: 'tool_output', tool: 'agent', tool_id: 'abort', output: '⏹ stopped by user', exit_code: 0 },
    ])

    expect(turn.bubbles[0].cards[0]).toMatchObject({
      toolId: 'abort',
      output: '⏹ stopped by user',
      state: 'done',
    })
  })

  test('busy bridge output ends the turn with the backend notice', () => {
    const turn = reduce([
      { type: 'tool_start', tool: 'bridge', tool_id: 'busy', command: 'turn in progress' },
      { type: 'tool_output', tool: 'bridge', tool_id: 'busy', output: 'Wait for it to finish.', exit_code: 1 },
    ])

    expect(turn.status).toBe('done')
    expect(turn.bubbles[0].cards[0]).toMatchObject({ toolId: 'busy', output: 'Wait for it to finish.' })
  })

  test('model fallback active and cleared frames toggle the banner text', () => {
    const active = reduce([{
      type: 'model_fallback',
      data: { old_model: 'a', new_model: 'b', reason: 'auth', attempts: [], phase: 'active' },
    }])
    expect(active.modelFallback).toBe('b')

    const cleared = applyEvent(active, {
      type: 'model_fallback',
      data: { old_model: 'a', new_model: 'b', reason: null, attempts: [], phase: 'cleared' },
    })
    expect(cleared.modelFallback).toBeUndefined()
  })

  test.each<ChatEvent>([
    { type: 'metrics', data: { response_time: 100 } },
    { type: 'run_alive' },
    { type: 'hb', turn_id: 1, elapsed_ms: 1000 },
  ])('$type does not change reducer state', (event) => {
    const turn = emptyTurn()
    expect(applyEvent(turn, event)).toBe(turn)
  })
})
