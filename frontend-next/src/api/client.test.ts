import { test, expect, vi, afterEach } from 'vitest'
import { apiJson, postStream } from './client'
import type { ChatEvent } from './events'

afterEach(() => vi.restoreAllMocks())

test('apiJson throws ApiError with status + body on 502 (gateway-down contract)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway restarting', { status: 502 })))
  await expect(apiJson('POST', '/api/x', {})).rejects.toMatchObject({ name: 'ApiError', status: 502 })
})

test('apiJson returns parsed JSON on 200', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })))
  await expect(apiJson('POST', '/api/x', { a: 1 })).resolves.toEqual({ ok: true })
})

function streamOf(chunks: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close() },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

test('postStream parses frames split across chunks, filters id:/keepalive lines, ends with onDone', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => streamOf([
    'data: {"type":"turn_start","turn_id":"t1","session_key":"k","ts":1}\n\n',
    'data: {"del', 'ta":"He"}\n\n: keepalive\n\n',
    'id: ev-42\ndata: {"delta":"llo"}\n\n',
    'data: [DONE]\n\n',
  ])))
  const events: ChatEvent[] = []
  const done = new Promise<void>((resolve, reject) => {
    postStream('/api/chat_stream', new FormData(), {
      onEvent: (ev) => events.push(ev),
      onDone: resolve,
      onError: reject,
    })
  })
  await done
  expect(events.map((e) => e.type)).toEqual(['turn_start', 'text', 'text', 'done'])
  expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['He', 'llo'])
})

test('postStream reports HTTP failure through onError, not onDone', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 502 })))
  const outcome = new Promise<string>((resolve) => {
    postStream('/api/chat_stream', new FormData(), {
      onEvent: () => {},
      onDone: () => resolve('done'),
      onError: () => resolve('error'),
    })
  })
  await expect(outcome).resolves.toBe('error')
})

test('aborting the controller calls neither onDone nor onError', async () => {
  const hanging = new ReadableStream({ start() { /* never closes */ } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(hanging, { status: 200 })))
  let called = ''
  const ctrl = postStream('/api/chat_stream', new FormData(), {
    onEvent: () => {},
    onDone: () => { called = 'done' },
    onError: () => { called = 'error' },
  })
  await new Promise((r) => setTimeout(r, 20))
  ctrl.abort()
  await new Promise((r) => setTimeout(r, 20))
  expect(called).toBe('')
})
