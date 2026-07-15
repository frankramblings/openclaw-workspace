// parseFrame against real frame samples from the bridge protocol
// (backend/bridge.py + chat_turn.py, catalogued 2026-07-15).
import { test, expect } from 'vitest'
import { parseFrame } from './events'

test('terminal [DONE] marker normalizes to done', () => {
  expect(parseFrame(' [DONE]')).toEqual({ type: 'done' })
})

test('turn lifecycle frames pass through typed (turn_id is an INT on the wire)', () => {
  expect(parseFrame(' {"type":"turn_start","turn_id":41,"session_key":"agent:main:web","ts":1752537600}'))
    .toEqual({ type: 'turn_start', turn_id: 41, session_key: 'agent:main:web', ts: 1752537600 })
  expect(parseFrame(' {"type":"turn_end","turn_id":41,"status":"aborted","ts":1752537700}'))
    .toMatchObject({ type: 'turn_end', turn_id: 41, status: 'aborted' })
  expect(parseFrame(' {"type":"hb","turn_id":41,"elapsed_ms":10000}'))
    .toMatchObject({ type: 'hb', elapsed_ms: 10000 })
})

test('bridge error cards arrive with missing or null tool_id and must parse', () => {
  const ev = parseFrame(' {"type":"tool_output","tool":"agent","output":"connection lost","exit_code":1}')
  expect(ev).toMatchObject({ type: 'tool_output', tool: 'agent', exit_code: 1 })
  expect(parseFrame(' {"type":"tool_start","tool":"x","tool_id":null}'))
    .toMatchObject({ type: 'tool_start', tool_id: null })
})

test('deferred-work token frames ride the same event log', () => {
  expect(parseFrame(' {"type":"token.added","turn_id":41,"token":"IMAGE","token_id":"tk1"}'))
    .toMatchObject({ type: 'token.added', token_id: 'tk1' })
  expect(parseFrame(' {"type":"token.resolved","turn_id":41,"token_id":"tk1","elapsed_ms":900}'))
    .toMatchObject({ type: 'token.resolved', token_id: 'tk1' })
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
  // bridge .get() chains can bottom out at None → nulls must parse
  expect(parseFrame(' {"type":"model_fallback","data":{"old_model":null,"new_model":null,"reason":null,"attempts":[],"phase":"cleared"}}'))
    .toMatchObject({ type: 'model_fallback', data: { old_model: null, phase: 'cleared' } })
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
