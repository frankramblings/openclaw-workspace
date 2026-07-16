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
  useChatStore.getState().stopActivityWatch()
  useChatStore.getState().cancelPending()
  useChatStore.setState({
    sessions: idle,
    activeSessionId: null,
    history: idle,
    hasMore: false,
    nextCursor: null,
    liveTurn: null,
    models: idle,
    defaultChat: idle,
    usage: idle,
    searchResults: idle,
    searchQuery: '',
    branchPrefix: null,
    pendingSend: null,
    queuedSends: {},
    sessionActivity: {},
    notificationsEnabled: false,
    pendingSessions: {},
    sessionError: null,
  })
  localStorage.clear()
})

test('semantic search publishes backend message hits', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json([{
    session_id: 'other', session_name: 'Other chat', role: 'assistant',
    content_snippet: 'matched text', timestamp: '2026-07-16T00:00:00Z', score: .9,
  }])))
  await useChatStore.getState().searchSessions('matched')
  expect(useChatStore.getState().searchResults).toMatchObject({
    status: 'ready', data: [{ session_id: 'other', content_snippet: 'matched text' }],
  })
})

test('branches through the selected bubble and rehydrates the echoed prefix', async () => {
  const branchBodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/session/branch') {
      branchBodies.push(JSON.parse(String(init?.body)))
      return json({ session_id: 'branch-1', session_key: 'agent:main:branch-1', prefix: [
        { id: 'u1', role: 'user', text: 'question' },
        { id: 'a1', role: 'assistant', text: 'answer' },
      ] })
    }
    if (path === '/api/sessions') return json([session, { ...session, id: 'branch-1' }])
    if (path.startsWith('/api/history/branch-1')) return json({ history: [], model: 'openclaw', hasMore: false, nextCursor: null })
    if (path.startsWith('/api/chat/turn')) return json({ active: false, events: [], last_event_id: null })
    throw new Error(`unexpected request: ${path}`)
  }))
  useChatStore.setState({
    activeSessionId: 'chat-1',
    history: { status: 'ready', fetchedAt: 1, data: [
      { id: 'u1', role: 'user', text: 'question', thinking: '', cards: [], images: [] },
      { id: 'a1', role: 'assistant', text: 'answer', thinking: '', cards: [], images: [] },
      { id: 'u2', role: 'user', text: 'later', thinking: '', cards: [], images: [] },
    ] },
  })

  expect(await useChatStore.getState().branchFromMessage('a1')).toBe(true)
  expect(branchBodies[0]).toMatchObject({ source_session_id: 'chat-1', prefix: [
    { id: 'u1', text: 'question' }, { id: 'a1', text: 'answer' },
  ] })
  expect(useChatStore.getState()).toMatchObject({ activeSessionId: 'branch-1', branchPrefix: [
    { id: 'u1', text: 'question' }, { id: 'a1', text: 'answer' },
  ] })
})

test('regenerate truncates at the preceding user and replays its attachments', async () => {
  let body: Record<string, unknown> | null = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/session/chat-1/truncate')
    body = JSON.parse(String(init?.body))
    return json({ ok: true })
  }))
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
    { id: 'a1', role: 'assistant', text: 'old', thinking: '', cards: [], images: [] },
    { id: 'u2', role: 'user', text: 'look', thinking: '', cards: [], images: [], attachments: [{ id: 'photo-1', name: 'photo.png' }] },
    { id: 'a2', role: 'assistant', text: 'replace me', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().regenerate('a2')).toBe(true)
  expect(body).toEqual({ keep_count: 2 })
  expect(useChatStore.getState().history).toMatchObject({ data: [{ id: 'u1' }, { id: 'a1' }] })
  expect(useChatStore.getState().pendingSend).toMatchObject({ text: 'look', opts: { attachments: [{ id: 'photo-1' }] } })
})

test('continue creates an explicit cutoff-aware follow-up', () => {
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'a1', role: 'assistant', text: 'partial answer', thinking: '', cards: [], images: [] },
  ] } })
  expect(useChatStore.getState().continueFrom('a1')).toBe(true)
  expect(useChatStore.getState().pendingSend?.text).toContain('partial answer')
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
    if (path === '/api/sessions/chat-1/usage') return json({
      ok: true, sessionId: 'chat-1', model: 'openclaw', modelProvider: 'openclaw',
      usage: { totalTokens: 1200, totalCost: 0, inputTokens: 1000, outputTokens: 200, messages: 4, toolCalls: 1, errors: 0 },
      context: { usedTokens: 1200, windowTokens: 10000, usedPct: 12, contextWindowSource: 'model', live: false, systemPromptChars: 0, systemPromptTokens: 0, tokenEstimate: false },
      updatedAt: '2026-07-16T00:00:00Z',
    })
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
    usage: { status: 'ready', data: { ok: true, context: { usedPct: 12 } } },
  })
})

test('feeds the POST stream through the reducer and refreshes authoritative history', async () => {
  let historyLoads = 0
  let streamForm: FormData | null = null
  const encoder = new TextEncoder()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.startsWith('/api/history/chat-1')) {
      historyLoads += 1
      return json({ history: [], model: 'openclaw', hasMore: false, nextCursor: null })
    }
    if (path === '/api/chat_stream') {
      streamForm = init?.body as FormData
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
  useChatStore.getState().send('Hi', { useResearch: true })
  useChatStore.getState().flushPending()

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
    expect(streamForm?.get('use_research')).toBe('true')
  })
})

test('buffers a send for editing and preserves multiple queued prompts while a turn is working', () => {
  useChatStore.setState({ activeSessionId: 'chat-1', liveTurn: null })
  useChatStore.getState().send('first draft')
  expect(useChatStore.getState().pendingSend).toMatchObject({ text: 'first draft', sessionId: 'chat-1' })
  useChatStore.getState().updatePending('edited draft')
  expect(useChatStore.getState().pendingSend).toMatchObject({ text: 'edited draft', bubble: { text: 'edited draft' } })

  useChatStore.setState({ pendingSend: null, liveTurn: { status: 'streaming', bubbles: [] } })
  useChatStore.getState().send('next prompt')
  useChatStore.getState().send('then another')
  expect(useChatStore.getState().queuedSends['chat-1']).toMatchObject([{ text: 'next prompt' }, { text: 'then another' }])
  expect(useChatStore.getState().recallQueued('chat-1')).toMatchObject({ text: 'next prompt' })
  expect(useChatStore.getState().queuedSends['chat-1']).toMatchObject([{ text: 'then another' }])
  expect(JSON.parse(localStorage.getItem('next:chat-queues') || '{}')['chat-1']).toMatchObject([{ text: 'then another' }])
})

test('activity snapshots mark background completions without inventing active work', async () => {
  let call = 0
  vi.stubGlobal('fetch', vi.fn(async () => json({ active: call++ === 0 ? ['other'] : [] })))
  await useChatStore.getState().refreshActivity()
  expect(useChatStore.getState().sessionActivity).toEqual({ other: 'working' })
  await useChatStore.getState().refreshActivity()
  expect(useChatStore.getState().sessionActivity).toEqual({ other: 'complete' })
  useChatStore.setState({ activeSessionId: 'other' })
  await useChatStore.getState().selectSession('other')
  expect(useChatStore.getState().sessionActivity).toEqual({})
})
