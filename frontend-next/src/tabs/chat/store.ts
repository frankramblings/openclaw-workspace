import { create } from 'zustand'
import { ApiError, apiDelete, apiForm, apiGet, apiJson, openSSE, postStream } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import { applyEvent, emptyTurn, type Bubble, type Turn } from './reducer'
import { parseHistory } from './history'
import { hydrateTurn, reconcileDecision, type TurnSnapshot } from './resume'
import { branchStorageKey, sliceBranchPrefix } from './parity'
import type { BranchResponse, DefaultChat, HistoryResponse, ModelEndpoint, ModelsResponse, SearchHit, SessionRecord, StopResponse } from './types'

export interface SendOptions {
  allowWebSearch?: boolean
  attachments?: string[]
}

export interface BufferedSend {
  sessionId: string
  text: string
  opts: SendOptions
  bubble: Bubble
  deadline: number
}

export interface ChatState {
  sessions: Remote<SessionRecord[]>
  activeSessionId: string | null
  history: Remote<Bubble[]>
  hasMore: boolean
  nextCursor: string | null
  liveTurn: Turn | null
  models: Remote<ModelEndpoint[]>
  defaultChat: Remote<DefaultChat>
  searchResults: Remote<SearchHit[]>
  searchQuery: string
  branchPrefix: Bubble[] | null
  pendingSend: BufferedSend | null
  queuedSends: Record<string, BufferedSend>
  pendingSessions: Record<string, string>
  sessionError: string | null
  loadSessions: () => Promise<void>
  loadModels: () => Promise<void>
  loadDefaultChat: () => Promise<void>
  searchSessions: (query: string) => Promise<void>
  branchFromMessage: (messageId: string) => Promise<boolean>
  updatePending: (text: string) => void
  flushPending: () => void
  cancelPending: () => void
  recallQueued: (sessionId: string) => BufferedSend | null
  cancelQueued: (sessionId: string) => void
  selectSession: (id: string) => Promise<void>
  loadOlder: () => Promise<void>
  createSession: (name?: string) => Promise<SessionRecord | null>
  renameSession: (id: string, name: string) => Promise<boolean>
  setSessionModel: (id: string, model: string, endpointId?: string) => Promise<boolean>
  setSessionSpeed: (id: string, speed: SessionRecord['speed']) => Promise<boolean>
  deleteSession: (id: string) => Promise<boolean>
  archiveSession: (id: string) => Promise<boolean>
  toggleImportant: (id: string, important: boolean) => Promise<boolean>
  setDefaultModel: (model: string, endpointId: string) => Promise<boolean>
  send: (text: string, opts?: SendOptions) => void
  stop: () => Promise<void>
}

const sessionsLoader = makeLoader<SessionRecord[]>()
const modelsLoader = makeLoader<ModelEndpoint[]>()
const defaultChatLoader = makeLoader<DefaultChat>()
const searchLoader = makeLoader<SearchHit[]>()
let historyEpoch = 0
let streamController: AbortController | null = null
let streamSessionId: string | null = null
let resumeSource: EventSource | null = null
let resumeSessionId: string | null = null
let resumeLastEventId: string | null = null
let lastStreamProgress = 0
let resumeWatch: ReturnType<typeof setInterval> | null = null
let historyReload: ((sessionId: string) => Promise<void>) | null = null
let bubbleSequence = 0
let pendingTimer: ReturnType<typeof setTimeout> | null = null
const SEND_GRACE_MS = 700

function errorMessage(error: unknown): { error: string; httpStatus?: number } {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ApiError ? { httpStatus: error.status } : {}),
  }
}

function staleHistory(remote: Remote<Bubble[]>): Bubble[] | undefined {
  if (remote.status === 'ready') return remote.data
  if (remote.status === 'loading' || remote.status === 'error') return remote.stale
  return undefined
}

function userBubble(text: string): Bubble {
  bubbleSequence += 1
  return {
    id: `user-${bubbleSequence}`,
    role: 'user',
    text,
    thinking: '',
    cards: [],
    images: [],
  }
}

function prefixBubbles(prefix: BranchResponse['prefix']): Bubble[] {
  return prefix.map((message) => ({ ...message, thinking: '', cards: [], images: [] }))
}

async function fetchSessions(): Promise<SessionRecord[]> {
  const data = await apiGet<unknown>('/api/sessions')
  if (!Array.isArray(data)) throw new Error('Invalid /api/sessions response: expected an array')
  return data as SessionRecord[]
}

async function fetchModels(): Promise<ModelEndpoint[]> {
  const data = await apiGet<unknown>('/api/models')
  if (!data || typeof data !== 'object' || !Array.isArray((data as ModelsResponse).items)) {
    throw new Error('Invalid /api/models response: expected {items: []}')
  }
  return (data as ModelsResponse).items
}

export const useChatStore = create<ChatState>((set, get) => {
  const loadHistory = async (sessionId: string): Promise<void> => {
    const epoch = ++historyEpoch
    const stale = staleHistory(get().history)
    set({
      history: stale === undefined ? { status: 'loading' } : { status: 'loading', stale },
      hasMore: false,
      nextCursor: null,
    })
    try {
      const page = await apiGet<HistoryResponse>(`/api/history/${encodeURIComponent(sessionId)}?limit=200`)
      if (epoch !== historyEpoch || get().activeSessionId !== sessionId) return
      set({
        history: { status: 'ready', data: parseHistory(page.history), fetchedAt: Date.now() },
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      })
    } catch (error) {
      if (epoch !== historyEpoch || get().activeSessionId !== sessionId) return
      set({
        history: { status: 'error', ...errorMessage(error), ...(stale === undefined ? {} : { stale }) },
        hasMore: false,
        nextCursor: null,
      })
    }
  }
  historyReload = loadHistory

  const isWorking = (): boolean => Boolean(get().liveTurn && ['sending', 'streaming', 'stalled'].includes(get().liveTurn!.status))

  const startStream = (draft: BufferedSend): void => {
    const { sessionId, text, opts } = draft
    streamController?.abort()
    const turn = { ...emptyTurn(), bubbles: [draft.bubble] }
    set({ liveTurn: turn })

    const form = new FormData()
    form.append('message', text)
    form.append('session', sessionId)
    if (opts.allowWebSearch) form.append('allow_web_search', 'true')
    if (opts.attachments?.length) form.append('attachments', JSON.stringify(opts.attachments))

    streamController = postStream('/api/chat_stream', form, {
      onEvent: (event) => {
        if (get().activeSessionId !== sessionId) return
        if (event.type === 'turn_start' && get().branchPrefix) {
          localStorage.removeItem(branchStorageKey(sessionId))
          set({ branchPrefix: null })
        }
        lastStreamProgress = Date.now()
        set((state) => ({ liveTurn: applyEvent(state.liveTurn ?? turn, event) }))
        if (event.type === 'turn_end') setTimeout(() => flushQueued(sessionId), 0)
      },
      onDone: (sawDone) => {
        streamController = null
        streamSessionId = null
        if (get().activeSessionId !== sessionId) return
        if (!sawDone) {
          set((state) => ({ liveTurn: state.liveTurn ? { ...state.liveTurn, status: 'error' } : null }))
        }
        void loadHistory(sessionId)
      },
      onError: () => {
        streamController = null
        streamSessionId = null
        if (get().activeSessionId !== sessionId) return
        set((state) => ({ liveTurn: state.liveTurn ? { ...state.liveTurn, status: 'error' } : null }))
      },
    })
    streamSessionId = sessionId
    lastStreamProgress = Date.now()
  }

  const flushPending = (): void => {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
    const pending = get().pendingSend
    if (!pending) return
    if (get().activeSessionId !== pending.sessionId || isWorking()) {
      set((state) => ({ pendingSend: null, queuedSends: { ...state.queuedSends, [pending.sessionId]: pending } }))
      return
    }
    set({ pendingSend: null })
    startStream(pending)
  }

  const flushQueued = (sessionId: string): void => {
    const queued = get().queuedSends[sessionId]
    if (!queued || get().activeSessionId !== sessionId || isWorking() || get().pendingSend) return
    const { [sessionId]: _sent, ...queuedSends } = get().queuedSends
    set({ queuedSends })
    startStream(queued)
  }

  return {
    sessions: idle,
    activeSessionId: null,
    history: idle,
    hasMore: false,
    nextCursor: null,
    liveTurn: null,
    models: idle,
    defaultChat: idle,
    searchResults: idle,
    searchQuery: '',
    branchPrefix: null,
    pendingSend: null,
    queuedSends: {},
    pendingSessions: {},
    sessionError: null,

    loadSessions: () => sessionsLoader(
      fetchSessions,
      (sessions) => set({ sessions }),
      get().sessions,
    ),

    loadModels: () => modelsLoader(
      fetchModels,
      (models) => set({ models }),
      get().models,
    ),

    loadDefaultChat: () => defaultChatLoader(
      () => apiGet<DefaultChat>('/api/default-chat'),
      (defaultChat) => set({ defaultChat }),
      get().defaultChat,
    ),

    searchSessions: async (query) => {
      const trimmed = query.trim()
      set({ searchQuery: query })
      if (trimmed.length < 2) { set({ searchResults: idle }); return }
      await searchLoader(
        () => apiGet<SearchHit[]>(`/api/search?q=${encodeURIComponent(trimmed)}&limit=20`),
        (searchResults) => set({ searchResults }),
        get().searchResults,
      )
    },

    branchFromMessage: async (messageId) => {
      const { activeSessionId, history, liveTurn } = get()
      if (!activeSessionId || history.status !== 'ready') return false
      const thread = [...history.data, ...(liveTurn?.bubbles ?? [])]
      const prefix = sliceBranchPrefix(thread, messageId)
      if (!prefix) { set({ sessionError: "Couldn't find that message" }); return false }
      set({ sessionError: null })
      try {
        const branched = await apiJson<BranchResponse>('POST', '/api/session/branch', {
          source_session_id: activeSessionId,
          prefix,
        })
        localStorage.setItem(branchStorageKey(branched.session_id), JSON.stringify(branched.prefix))
        await get().loadSessions()
        await get().selectSession(branched.session_id)
        return true
      } catch (error) {
        set({ sessionError: errorMessage(error).error })
        return false
      }
    },

    updatePending: (text) => set((state) => state.pendingSend ? {
      pendingSend: { ...state.pendingSend, text, bubble: { ...state.pendingSend.bubble, text } },
    } : {}),

    flushPending,

    cancelPending: () => {
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = null
      set({ pendingSend: null })
    },

    recallQueued: (sessionId) => {
      const queued = get().queuedSends[sessionId] ?? null
      if (!queued) return null
      const { [sessionId]: _recalled, ...queuedSends } = get().queuedSends
      set({ queuedSends })
      return queued
    },

    cancelQueued: (sessionId) => {
      const { [sessionId]: _cancelled, ...queuedSends } = get().queuedSends
      set({ queuedSends })
    },

    selectSession: async (id) => {
      // Detaching a reader does not stop its server-side turn. Task 1.5 will
      // reattach from the durable event log when this session is selected again.
      const pending = get().pendingSend
      if (pending && pending.sessionId !== id) {
        if (pendingTimer) clearTimeout(pendingTimer)
        pendingTimer = null
        set((state) => ({ pendingSend: null, queuedSends: { ...state.queuedSends, [pending.sessionId]: pending } }))
      }
      streamController?.abort()
      streamController = null
      streamSessionId = null
      closeResume()
      let branchPrefix: Bubble[] | null = null
      try {
        const raw = localStorage.getItem(branchStorageKey(id))
        if (raw) branchPrefix = prefixBubbles(JSON.parse(raw) as BranchResponse['prefix'])
      } catch { /* corrupt local branch display state is safely ignored */ }
      set({ activeSessionId: id, liveTurn: null, branchPrefix })
      await loadHistory(id)
      await reconcileSession(id, set, get)
      flushQueued(id)
    },

    loadOlder: async () => {
      const { activeSessionId, nextCursor, history } = get()
      if (!activeSessionId || !nextCursor) return
      const epoch = ++historyEpoch
      const current = staleHistory(history) ?? []
      set({ history: { status: 'loading', stale: current } })
      try {
        const page = await apiGet<HistoryResponse>(
          `/api/history/${encodeURIComponent(activeSessionId)}?limit=200&cursor=${encodeURIComponent(nextCursor)}`,
        )
        if (epoch !== historyEpoch || get().activeSessionId !== activeSessionId) return
        set({
          history: { status: 'ready', data: [...parseHistory(page.history), ...current], fetchedAt: Date.now() },
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        })
      } catch (error) {
        if (epoch !== historyEpoch || get().activeSessionId !== activeSessionId) return
        set({ history: { status: 'error', ...errorMessage(error), stale: current } })
      }
    },

    createSession: async (name = 'New chat') => {
      set({ sessionError: null, pendingSessions: { ...get().pendingSessions, new: 'creating' } })
      try {
        const currentDefault = get().defaultChat
        let defaults = currentDefault.status === 'ready' ? currentDefault.data : null
        if (!defaults) defaults = await apiGet<DefaultChat>('/api/default-chat')
        const created = await apiForm<SessionRecord>('/api/session', {
          name,
          model: defaults.model,
          endpoint_url: defaults.endpoint_url,
          endpoint_id: defaults.endpoint_id,
        })
        await get().loadSessions()
        await get().selectSession(created.id)
        return created
      } catch (error) {
        set({ sessionError: errorMessage(error).error })
        return null
      } finally {
        const { new: _new, ...pendingSessions } = get().pendingSessions
        set({ pendingSessions })
      }
    },

    renameSession: (id, name) => runSessionMutation(set, get, id, 'renaming', () =>
      apiForm<SessionRecord>(`/api/session/${encodeURIComponent(id)}`, { name }, 'PATCH')),

    setSessionModel: (id, model, endpointId = '') => runSessionMutation(set, get, id, 'changing model', () =>
      apiForm<SessionRecord>(`/api/session/${encodeURIComponent(id)}`, {
        model,
        ...(endpointId ? { endpoint_id: endpointId } : {}),
      }, 'PATCH')),

    setSessionSpeed: (id, speed) => runSessionMutation(set, get, id, 'changing speed', () =>
      apiForm<SessionRecord>(`/api/session/${encodeURIComponent(id)}`, { speed }, 'PATCH')),

    deleteSession: (id) => runSessionMutation(set, get, id, 'deleting', async () => {
      await apiDelete<{ ok: boolean }>(`/api/session/${encodeURIComponent(id)}`)
      if (get().activeSessionId === id) {
        set({ activeSessionId: null, history: idle, liveTurn: null, hasMore: false, nextCursor: null })
      }
    }),

    archiveSession: (id) => runSessionMutation(set, get, id, 'archiving', async () => {
      await apiJson<{ ok: boolean }>('POST', `/api/session/${encodeURIComponent(id)}/archive`)
      if (get().activeSessionId === id) {
        set({ activeSessionId: null, history: idle, liveTurn: null, hasMore: false, nextCursor: null })
      }
    }),

    toggleImportant: (id, important) => runSessionMutation(set, get, id, 'updating favorite', () =>
      apiForm<{ ok: boolean; important: boolean }>(
        `/api/session/${encodeURIComponent(id)}/important`,
        { important: String(important) },
      )),

    setDefaultModel: async (model, endpointId) => {
      set({ sessionError: null })
      try {
        await apiJson('POST', '/api/default-chat', { model, endpoint_id: endpointId })
        await get().loadDefaultChat()
        return true
      } catch (error) {
        set({ sessionError: errorMessage(error).error })
        return false
      }
    },

    send: (text, opts = {}) => {
      const sessionId = get().activeSessionId
      if (!sessionId) throw new Error('Select a chat before sending')
      if (!text.trim() && !(opts.attachments?.length)) return
      const buffered: BufferedSend = {
        sessionId, text, opts, bubble: userBubble(text), deadline: Date.now() + SEND_GRACE_MS,
      }
      if (isWorking() || get().pendingSend) {
        set((state) => ({ queuedSends: { ...state.queuedSends, [sessionId]: buffered } }))
        return
      }
      set({ pendingSend: buffered })
      pendingTimer = setTimeout(flushPending, SEND_GRACE_MS)
    },

    stop: async () => {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      // Keep the reader attached: the backend emits the authoritative aborted
      // turn_end after this request, and the reducer owns that transition.
      await apiJson<StopResponse>('POST', `/api/chat/stop/${encodeURIComponent(sessionId)}`)
    },
  }
})

function closeResume(): void {
  resumeSource?.close()
  resumeSource = null
  resumeSessionId = null
  resumeLastEventId = null
  if (resumeWatch) clearInterval(resumeWatch)
  resumeWatch = null
}

async function reconcileSession(
  sessionId: string,
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
): Promise<void> {
  let snapshot: TurnSnapshot
  try {
    snapshot = await apiGet<TurnSnapshot>(`/api/chat/turn?session=${encodeURIComponent(sessionId)}`)
  } catch {
    return
  }
  if (get().activeSessionId !== sessionId) return
  const localSession = streamSessionId ?? resumeSessionId
  const action = reconcileDecision({
    active: snapshot.active,
    lastTurnStatus: snapshot.last_turn?.status ?? null,
    hasLocalLive: Boolean(streamController || resumeSource),
    localSessionMatches: localSession === sessionId,
    localFresh: Date.now() - lastStreamProgress <= 25_000,
  })
  if (action === 'none') return
  if (action === 'finalize-interrupted' || action === 'finalize-stale') {
    closeResume()
    set((state) => ({
      liveTurn: state.liveTurn ? {
        ...state.liveTurn,
        status: action === 'finalize-interrupted' ? 'error' : 'done',
      } : null,
    }))
    return
  }

  streamController?.abort()
  streamController = null
  streamSessionId = null
  closeResume()
  const hydrated = hydrateTurn(snapshot.events)
  set({ liveTurn: snapshot.active ? { ...hydrated, status: hydrated.status === 'sending' ? 'streaming' : hydrated.status } : hydrated })
  resumeSessionId = sessionId
  resumeLastEventId = snapshot.last_event_id
  lastStreamProgress = Date.now()
  if (typeof EventSource === 'undefined') return
  const cursor = resumeLastEventId ? `&last_event_id=${encodeURIComponent(resumeLastEventId)}` : ''
  resumeSource = openSSE(`/api/chat/stream?session=${encodeURIComponent(sessionId)}${cursor}`, (event, id) => {
    if (get().activeSessionId !== sessionId) return
    lastStreamProgress = Date.now()
    if (id) resumeLastEventId = id
    set((state) => ({ liveTurn: applyEvent(state.liveTurn ?? emptyTurn(), event) }))
    if (event.type === 'turn_end') {
      closeResume()
      void historyReload?.(sessionId)
    }
  })
  resumeWatch = setInterval(() => {
    if (Date.now() - lastStreamProgress > 25_000) void reconcileSession(sessionId, set, get)
  }, 5_000)
}

async function runSessionMutation(
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  id: string,
  label: string,
  mutate: () => Promise<unknown>,
): Promise<boolean> {
  set({ sessionError: null, pendingSessions: { ...get().pendingSessions, [id]: label } })
  try {
    await mutate()
    await get().loadSessions()
    return true
  } catch (error) {
    set({ sessionError: errorMessage(error).error })
    return false
  } finally {
    const { [id]: _finished, ...pendingSessions } = get().pendingSessions
    set({ pendingSessions })
  }
}
