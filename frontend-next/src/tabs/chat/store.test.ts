import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useChatStore } from './store'
import type { SessionRecord } from './types'

const session: SessionRecord = {
  id: 'chat-1',
  name: 'Test chat',
  model: 'openclaw',
  speed: 'normal',
  sessionKey: 'agent:main:web-chat-1',
  endpoint_url: 'ws://127.0.0.1:18789',
  endpoint_id: 'openclaw',
  folder: null,
  archived: false,
  important: false,
  created: 1,
  updated: 1,
  origin: null,
  gary_terminal: null,
}

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

beforeEach(() => {
  useChatStore.setState({
    sessions: idle,
    activeSessionId: null,
    history: idle,
    hasMore: false,
    nextCursor: null,
    liveTurn: null,
    models: idle,
    defaultChat: idle,
    pendingSessions: {},
    sessionError: null,
  })
})

afterEach(() => vi.unstubAllGlobals())

test('loads sessions and a selected session history from their responses', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/sessions') return json([session])
    if (path.startsWith('/api/history/chat-1')) {
      return json({
        history: [{ role: 'assistant', content: 'hello' }],
        model: 'openclaw',
        hasMore: true,
        nextCursor: 'older-1',
      })
    }
    throw new Error(`unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  await useChatStore.getState().loadSessions()
  await useChatStore.getState().selectSession('chat-1')

  expect(useChatStore.getState()).toMatchObject({
    sessions: { status: 'ready', data: [session] },
    activeSessionId: 'chat-1',
    history: { status: 'ready', data: [expect.objectContaining({ role: 'assistant', text: 'hello' })] },
    hasMore: true,
    nextCursor: 'older-1',
  })
})

test('feeds the POST stream through the reducer and refreshes authoritative history', async () => {
  let historyLoads = 0
  const encoder = new TextEncoder()
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.startsWith('/api/history/chat-1')) {
      historyLoads += 1
      return json({ history: [], model: 'openclaw', hasMore: false, nextCursor: null })
    }
    if (path === '/api/chat_stream') {
      const frames = [
        'data: {"type":"turn_start","turn_id":7,"session_key":"agent:main:web-chat-1","ts":1}\n\n',
        'data: {"delta":"Hello","thinking":false}\n\n',
        'data: {"type":"turn_end","turn_id":7,"status":"ok","ts":2}\n\n',
        'data: [DONE]\n\n',
      ]
      return new Response(new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame))
          controller.close()
        },
      }), { status: 200 })
    }
    throw new Error(`unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  await useChatStore.getState().selectSession('chat-1')
  useChatStore.getState().send('Hi')

  await vi.waitFor(() => {
    expect(useChatStore.getState().liveTurn).toMatchObject({
      turnId: 7,
      status: 'done',
      bubbles: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello' },
      ],
    })
    expect(historyLoads).toBe(2)
  })
})
