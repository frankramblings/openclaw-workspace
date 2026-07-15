// parseFrame against real frame samples from the bridge protocol
// (backend/bridge.py + chat_turn.py, catalogued 2026-07-15).
import { test, expect } from 'vitest'
import { parseFrame } from './events'

test('terminal [DONE] marker normalizes to done', () => {
  expect(parseFrame(' [DONE]')).toEqual({ type: 'done' })
})

test('turn lifecycle frames pass through typed', () => {
  expect(parseFrame(' {"type":"turn_start","turn_id":"t1","session_key":"agent:main:web","ts":1752537600}'))
    .toEqual({ type: 'turn_start', turn_id: 't1', session_key: 'agent:main:web', ts: 1752537600 })
  expect(parseFrame(' {"type":"turn_end","turn_id":"t1","status":"aborted","ts":1752537700}'))
    .toMatchObject({ type: 'turn_end', status: 'aborted' })
  expect(parseFrame(' {"type":"hb","turn_id":"t1","elapsed_ms":10000}'))
    .toMatchObject({ type: 'hb', elapsed_ms: 10000 })
})

test('typeless text delta normalizes to text event, thinking defaults false', () => {
  expect(parseFrame(' {"delta":"Hello"}')).toEqual({ type: 'text', delta: 'Hello', thinking: false })
  expect(parseFrame(' {"delta":"hmm","thinking":true}')).toEqual({ type: 'text', delta: 'hmm', thinking: true })
})

test('typeless image frame normalizes to image event', () => {
  expect(parseFrame(' {"image_url":"/api/x.png","image_prompt":"a cat"}'))
    .toEqual({ type: 'image', url: '/api/x.png', prompt: 'a cat' })
  expect(parseFrame(' {"image_url":"/api/y.png"}'))
    .toEqual({ type: 'image', url: '/api/y.png', prompt: undefined })
})

test('tool frames keep pairing fields', () => {
  expect(parseFrame(' {"type":"tool_start","tool":"Bash","tool_id":"call_1","command":"ls","round":1}'))
    .toMatchObject({ type: 'tool_start', tool: 'Bash', tool_id: 'call_1', command: 'ls' })
  expect(parseFrame(' {"type":"tool_output","tool":"Bash","tool_id":"call_1","output":"ok","exit_code":0}'))
    .toMatchObject({ type: 'tool_output', tool_id: 'call_1', exit_code: 0 })
})

test('stall, fallback, promise, metrics, reset frames parse', () => {
  expect(parseFrame(' {"type":"stall","silent_for":45}')).toMatchObject({ type: 'stall', silent_for: 45 })
  expect(parseFrame(' {"type":"stall_retry"}')).toEqual({ type: 'stall_retry' })
  expect(parseFrame(' {"type":"model_fallback","data":{"old_model":"a","new_model":"b","reason":"r","attempts":[],"phase":"active"}}'))
    .toMatchObject({ type: 'model_fallback', data: { phase: 'active' } })
  expect(parseFrame(' {"type":"promise_warning","phrase":"I will check back"}'))
    .toMatchObject({ type: 'promise_warning' })
  expect(parseFrame(' {"type":"metrics","data":{"response_time":1.5}}'))
    .toMatchObject({ type: 'metrics' })
  expect(parseFrame(' {"type":"reply_reset"}')).toEqual({ type: 'reply_reset' })
  expect(parseFrame(' {"type":"agent_step"}')).toEqual({ type: 'agent_step' })
})

test('garbage, empty, and unknown-shape payloads return null', () => {
  expect(parseFrame('')).toBeNull()
  expect(parseFrame('   ')).toBeNull()
  expect(parseFrame('not json')).toBeNull()
  expect(parseFrame('"a bare string"')).toBeNull()
  expect(parseFrame('{"neither":"delta nor type"}')).toBeNull()
  expect(parseFrame('null')).toBeNull()
})
