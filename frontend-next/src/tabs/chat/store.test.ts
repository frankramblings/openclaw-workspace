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
    editingMessageId: null,
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

test('regenerate with model option calls setSessionModel before truncate', async () => {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/sessions') return json([{ id: 'chat-1', model: 'gpt-4', speed: 'normal', archived: false, important: false, sessionKey: 'key', endpoint_url: '', endpoint_id: 'openai', name: 'test', folder: null, created: 1, updated: 1, origin: null, gary_terminal: null }])
    requests.push(path)
    if (path === '/api/session/chat-1') return json({ id: 'chat-1', model: 'gpt-4', speed: 'normal', archived: false, important: false, sessionKey: 'key', endpoint_url: '', endpoint_id: 'openai', name: 'test', folder: null, created: 1, updated: 1, origin: null, gary_terminal: null })
    if (path === '/api/session/chat-1/truncate') return json({ ok: true })
    throw new Error(`unexpected request: ${path}`)
  }))
  useChatStore.setState({ activeSessionId: 'chat-1', sessions: { status: 'ready', fetchedAt: 1, data: [{ id: 'chat-1', model: 'openclaw', speed: 'normal', archived: false, important: false, sessionKey: 'key', endpoint_url: '', endpoint_id: 'openclaw', name: 'test', folder: null, created: 1, updated: 1, origin: null, gary_terminal: null }] }, history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'question', thinking: '', cards: [], images: [] },
    { id: 'a1', role: 'assistant', text: 'answer', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().regenerate('a1', { model: 'gpt-4', endpointId: 'openai' })).toBe(true)
  expect(requests[0]).toContain('/api/session/chat-1')
  expect(requests[1]).toBe('/api/session/chat-1/truncate')
})

test('regenerate with model fails if setSessionModel fails and never truncates', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/session/chat-1') return new Response('API error', { status: 500 })
    throw new Error(`unexpected request: ${path}`)
  }))
  useChatStore.setState({ activeSessionId: 'chat-1', sessions: { status: 'ready', fetchedAt: 1, data: [] }, history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'question', thinking: '', cards: [], images: [] },
    { id: 'a1', role: 'assistant', text: 'answer', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().regenerate('a1', { model: 'gpt-4', endpointId: 'openai' })).toBe(false)
  expect(useChatStore.getState().history).toMatchObject({ data: [{ id: 'u1' }, { id: 'a1' }] })
})

test('continue creates an explicit cutoff-aware follow-up', () => {
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'a1', role: 'assistant', text: 'partial answer', thinking: '', cards: [], images: [] },
  ] } })
  expect(useChatStore.getState().continueFrom('a1')).toBe(true)
  expect(useChatStore.getState().pendingSend?.text).toContain('partial answer')
})

test('startEdit sets editingMessageId for user messages when idle', () => {
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
  ] } })
  useChatStore.getState().startEdit('u1')
  expect(useChatStore.getState().editingMessageId).toBe('u1')
})

test('startEdit does nothing for assistant messages', () => {
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'a1', role: 'assistant', text: 'answer', thinking: '', cards: [], images: [] },
  ] } })
  useChatStore.getState().startEdit('a1')
  expect(useChatStore.getState().editingMessageId).toBe(null)
})

test('cancelEdit clears editingMessageId', () => {
  useChatStore.setState({ editingMessageId: 'u1' })
  useChatStore.getState().cancelEdit()
  expect(useChatStore.getState().editingMessageId).toBe(null)
})

test('editMessage truncates at the message index and replays with edited text and original attachments', async () => {
  let body: Record<string, unknown> | null = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/session/chat-1/truncate') {
      body = JSON.parse(String(init?.body))
      return json({ ok: true })
    }
    throw new Error(`unexpected request: ${String(input)}`)
  }))
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
    { id: 'a1', role: 'assistant', text: 'answer', thinking: '', cards: [], images: [] },
    { id: 'u2', role: 'user', text: 'second', thinking: '', cards: [], images: [], attachments: [{ id: 'doc-1', name: 'doc.pdf' }] },
    { id: 'a2', role: 'assistant', text: 'old answer', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().editMessage('u2', 'edited second')).toBe(true)
  expect(body).toEqual({ keep_count: 2 })
  expect(useChatStore.getState().history).toMatchObject({ data: [{ id: 'u1' }, { id: 'a1' }] })
  expect(useChatStore.getState().pendingSend).toMatchObject({ text: 'edited second', opts: { attachments: [{ id: 'doc-1' }] } })
  expect(useChatStore.getState().editingMessageId).toBe(null)
})

test('editMessage fails if truncate fails and keeps editingMessageId', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('API error', { status: 500 })))
  useChatStore.setState({ activeSessionId: 'chat-1', editingMessageId: 'u1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().editMessage('u1', 'edited first')).toBe(false)
  expect(useChatStore.getState().editingMessageId).toBe('u1')
  expect(useChatStore.getState().sessionError).toBeTruthy()
})

test('editMessage on a network failure (fetch rejects) also keeps edit mode + text, no partial state change', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
  useChatStore.setState({ activeSessionId: 'chat-1', editingMessageId: 'u1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().editMessage('u1', 'edited first')).toBe(false)
  expect(useChatStore.getState().editingMessageId).toBe('u1')
  expect(useChatStore.getState().sessionError).toBeTruthy()
  // history untouched — no optimistic slice happened before the network error
  expect(useChatStore.getState().history).toMatchObject({ data: [{ id: 'u1' }] })
})

test('startEdit refuses while a turn is sending/streaming/stalled', () => {
  for (const status of ['sending', 'streaming', 'stalled'] as const) {
    useChatStore.setState({
      editingMessageId: null,
      activeSessionId: 'chat-1',
      liveTurn: { status, bubbles: [] } as any,
      history: { status: 'ready', fetchedAt: 1, data: [
        { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
      ] },
    })
    useChatStore.getState().startEdit('u1')
    expect(useChatStore.getState().editingMessageId).toBe(null)
  }
})

test('editMessage refuses while a turn is streaming (no truncate attempted)', async () => {
  const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
  vi.stubGlobal('fetch', fetchMock)
  useChatStore.setState({
    activeSessionId: 'chat-1',
    liveTurn: { status: 'streaming', bubbles: [] } as any,
    history: { status: 'ready', fetchedAt: 1, data: [
      { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
    ] },
  })
  expect(await useChatStore.getState().editMessage('u1', 'edited')).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('editMessage refuses for an assistant message id (no truncate attempted)', async () => {
  const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
  vi.stubGlobal('fetch', fetchMock)
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'a1', role: 'assistant', text: 'answer', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().editMessage('a1', 'edited')).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('editMessage refuses for a stale id no longer in history (e.g. dropped by a background refetch)', async () => {
  const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
  vi.stubGlobal('fetch', fetchMock)
  useChatStore.setState({ activeSessionId: 'chat-1', editingMessageId: 'u1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u2', role: 'user', text: 'still here', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().editMessage('u1', 'edited')).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('editMessage at index 0 truncates the whole history (keep_count 0)', async () => {
  let body: Record<string, unknown> | null = null
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return json({ ok: true })
  }))
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
    { id: 'a1', role: 'assistant', text: 'answer', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().editMessage('u1', 'edited first')).toBe(true)
  expect(body).toEqual({ keep_count: 0 })
  expect(useChatStore.getState().history).toMatchObject({ data: [] })
})

test('editMessage picks the exact message by id among consecutive user messages, unaffected by role adjacency', async () => {
  let body: Record<string, unknown> | null = null
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return json({ ok: true })
  }))
  // u1, u2 back-to-back (no assistant turn between them — e.g. a queued follow-up)
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
    { id: 'u2', role: 'user', text: 'second', thinking: '', cards: [], images: [] },
    { id: 'u3', role: 'user', text: 'third', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().editMessage('u2', 'edited second')).toBe(true)
  expect(body).toEqual({ keep_count: 1 })
  expect(useChatStore.getState().history).toMatchObject({ data: [{ id: 'u1' }] })
  expect(useChatStore.getState().pendingSend).toMatchObject({ text: 'edited second' })
})

test('editMessage allows empty text when the original message has attachments (OR-semantics: non-empty text OR attachments retained)', async () => {
  let body: Record<string, unknown> | null = null
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return json({ ok: true })
  }))
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'caption', thinking: '', cards: [], images: [], attachments: [{ id: 'photo-1', name: 'photo.png' }] },
  ] } })
  expect(await useChatStore.getState().editMessage('u1', '')).toBe(true)
  expect(body).toEqual({ keep_count: 0 })
  expect(useChatStore.getState().pendingSend).toMatchObject({ text: '', opts: { attachments: [{ id: 'photo-1' }] } })
})

test('editMessage rejects empty text with no attachments (no truncate attempted)', async () => {
  const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
  vi.stubGlobal('fetch', fetchMock)
  useChatStore.setState({ activeSessionId: 'chat-1', history: { status: 'ready', fetchedAt: 1, data: [
    { id: 'u1', role: 'user', text: 'first', thinking: '', cards: [], images: [] },
  ] } })
  expect(await useChatStore.getState().editMessage('u1', '   ')).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
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

test('selectSession posts ack to /api/push/ack with session_id (fire-and-forget)', async () => {
  const ackCalls: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input)
    if (init?.body) ackCalls.push({ path, body: JSON.parse(String(init.body)) })
    if (path === '/api/strip/state') return json({ tasks: [] })
    if (path === '/api/sessions') return json([session])
    if (path === '/api/turn/fetch') return json({ thread: [{ id: '1', role: 'user', text: 'Hi' }], title: 'Chat', subtitle: '', model: 'openclaw' })
    if (path === '/api/push/ack') return json({ unseen: 0 })
    return json({})
  }))
  await useChatStore.getState().selectSession('chat-1')
  expect(ackCalls).toContainEqual({ path: '/api/push/ack', body: { session_id: 'chat-1' } })
  vi.unstubAllGlobals()
})
afterEach(() => vi.unstubAllGlobals())
