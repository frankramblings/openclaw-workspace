import { create } from 'zustand'
import { ApiError, apiDelete, apiForm, apiGet, apiJson, openSSE, postStream } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import { applyEvent, emptyTurn, type Bubble, type Turn } from './reducer'
import { parseHistory } from './history'
import { hydrateTurn, reconcileDecision, type TurnSnapshot } from './resume'
import { branchStorageKey, sliceBranchPrefix } from './parity'
import type { BranchResponse, DefaultChat, HistoryResponse, ModelEndpoint, ModelsResponse, SearchHit, SessionRecord, SessionUsage, StopResponse } from './types'

export interface SendOptions {
  allowWebSearch?: boolean
  useResearch?: boolean
  attachments?: Array<{ id: string; name: string; url?: string }>
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
  usage: Remote<SessionUsage>
  searchResults: Remote<SearchHit[]>
  searchQuery: string
  branchPrefix: Bubble[] | null
  pendingSend: BufferedSend | null
  queuedSends: Record<string, BufferedSend[]>
  sessionActivity: Record<string, 'working' | 'complete'>
  notificationsEnabled: boolean
  pendingSessions: Record<string, string>
  sessionError: string | null
  loadSessions: () => Promise<void>
  loadModels: () => Promise<void>
  loadDefaultChat: () => Promise<void>
  loadUsage: (sessionId?: string) => Promise<void>
  searchSessions: (query: string) => Promise<void>
  branchFromMessage: (messageId: string) => Promise<boolean>
  regenerate: (messageId: string) => Promise<boolean>
  continueFrom: (messageId: string) => boolean
  updatePending: (text: string) => void
  flushPending: () => void
  cancelPending: () => void
  recallQueued: (sessionId: string) => BufferedSend | null
  cancelQueued: (sessionId: string) => void
  refreshActivity: () => Promise<void>
  startActivityWatch: () => void
  stopActivityWatch: () => void
  enableNotifications: () => Promise<void>
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
const usageLoader = makeLoader<SessionUsage>()
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
let activityTimer: ReturnType<typeof setInterval> | null = null
let knownActive: Set<string> | null = null

function stored<T>(key: string, fallback: T): T {
  try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value ?? fallback } catch { return fallback }
}

function initialQueues(): Record<string, BufferedSend[]> {
  const queues = stored<Record<string, BufferedSend[]>>('next:chat-queues', {})
  const pending = stored<BufferedSend | null>('next:chat-pending', null)
  localStorage.removeItem('next:chat-pending')
  if (pending?.sessionId) queues[pending.sessionId] = [...(queues[pending.sessionId] ?? []), pending]
  return queues
}

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

function userBubble(text: string, attachments: SendOptions['attachments'] = []): Bubble {
  bubbleSequence += 1
  return {
    id: `user-${bubbleSequence}`,
    role: 'user',
    text,
    thinking: '',
    cards: [],
    images: [],
    attachments,
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
    set((state) => ({ liveTurn: turn, sessionActivity: { ...state.sessionActivity, [sessionId]: 'working' } }))

    const form = new FormData()
    form.append('message', text)
    form.append('session', sessionId)
    if (opts.allowWebSearch) form.append('allow_web_search', 'true')
    if (opts.useResearch) form.append('use_research', 'true')
    if (opts.attachments?.length) form.append('attachments', JSON.stringify(opts.attachments.map((attachment) => attachment.id)))

    streamController = postStream('/api/chat_stream', form, {
      onEvent: (event) => {
        if (get().activeSessionId !== sessionId) return
        if (event.type === 'turn_start' && get().branchPrefix) {
          localStorage.removeItem(branchStorageKey(sessionId))
          set({ branchPrefix: null })
        }
        lastStreamProgress = Date.now()
        set((state) => ({ liveTurn: applyEvent(state.liveTurn ?? turn, event) }))
        if (event.type === 'turn_end') {
          const { [sessionId]: _finished, ...sessionActivity } = get().sessionActivity
          set({ sessionActivity })
          setTimeout(() => flushQueued(sessionId), 0)
        }
      },
      onDone: (sawDone) => {
        streamController = null
        streamSessionId = null
        if (get().activeSessionId !== sessionId) return
        if (!sawDone) {
          set((state) => ({ liveTurn: state.liveTurn ? { ...state.liveTurn, status: 'error' } : null }))
          const { [sessionId]: _finished, ...sessionActivity } = get().sessionActivity
          set({ sessionActivity })
        }
        void loadHistory(sessionId)
        void get().loadUsage(sessionId)
      },
      onError: () => {
        streamController = null
        streamSessionId = null
        if (get().activeSessionId !== sessionId) return
        set((state) => ({ liveTurn: state.liveTurn ? { ...state.liveTurn, status: 'error' } : null }))
        const { [sessionId]: _finished, ...sessionActivity } = get().sessionActivity
        set({ sessionActivity })
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
      set((state) => ({ pendingSend: null, queuedSends: { ...state.queuedSends, [pending.sessionId]: [...(state.queuedSends[pending.sessionId] ?? []), pending] } }))
      return
    }
    set({ pendingSend: null })
    startStream(pending)
  }

  const flushQueued = (sessionId: string): void => {
    const queue = get().queuedSends[sessionId]
    if (!queue?.length || get().activeSessionId !== sessionId || isWorking() || get().pendingSend) return
    const [queued, ...remaining] = queue
    const queuedSends = { ...get().queuedSends }
    if (remaining.length) queuedSends[sessionId] = remaining
    else delete queuedSends[sessionId]
    set({ queuedSends })
    startStream(queued)
  }

  const notifyCompletion = (sessionId: string): void => {
    if (!get().notificationsEnabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const sessions = get().sessions
    const title = sessions.status === 'ready' ? sessions.data.find((session) => session.id === sessionId)?.name : null
    const notification = new Notification('Reply finished', { body: title || 'A conversation finished working.', tag: `next-turn-${sessionId}` })
    notification.onclick = () => {
      window.focus()
      location.hash = '#/chat'
      void get().selectSession(sessionId)
      notification.close()
    }
  }

  const refreshActivity = async (): Promise<void> => {
    try {
      const response = await apiGet<{ active: string[] }>('/api/chat/active_sessions')
      const active = new Set(Array.isArray(response.active) ? response.active : [])
      if (knownActive === null) {
        knownActive = active
        set(state => {
          const sessionActivity = { ...state.sessionActivity }
          for (const [id, status] of Object.entries(sessionActivity)) if (status === 'working' && !active.has(id)) sessionActivity[id] = 'complete'
          for (const id of active) sessionActivity[id] = 'working'
          return { sessionActivity }
        })
        return
      }
      const next = { ...get().sessionActivity }
      for (const id of active) next[id] = 'working'
      for (const id of knownActive) {
        if (active.has(id)) continue
        if (id === get().activeSessionId) delete next[id]
        else { next[id] = 'complete'; notifyCompletion(id) }
      }
      knownActive = active
      set({ sessionActivity: next })
    } catch { /* the visible gateway status owns connection errors */ }
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
    usage: idle,
    searchResults: idle,
    searchQuery: '',
    branchPrefix: null,
    pendingSend: null,
    queuedSends: initialQueues(),
    sessionActivity: stored<Record<string, 'working' | 'complete'>>('next:chat-activity', {}),
    notificationsEnabled: typeof Notification !== 'undefined' && Notification.permission === 'granted',
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

    loadUsage: async (sessionId = get().activeSessionId ?? undefined) => {
      if (!sessionId) { set({ usage: idle }); return }
      await usageLoader(
        () => apiGet<SessionUsage>(`/api/sessions/${encodeURIComponent(sessionId)}/usage`),
        (usage) => { if (get().activeSessionId === sessionId) set({ usage }) },
        get().usage,
      )
    },

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

    regenerate: async (messageId) => {
      const { activeSessionId, history, liveTurn } = get()
      if (!activeSessionId || history.status !== 'ready' || (liveTurn && ['sending', 'streaming', 'stalled'].includes(liveTurn.status))) return false
      const assistantIndex = history.data.findIndex(bubble => bubble.id === messageId && bubble.role === 'assistant')
      if (assistantIndex < 0) return false
      let userIndex = assistantIndex - 1
      while (userIndex >= 0 && history.data[userIndex].role !== 'user') userIndex -= 1
      const user = history.data[userIndex]
      if (!user || (!user.text.trim() && !user.attachments?.length)) return false
      try {
        await apiJson('POST', `/api/session/${encodeURIComponent(activeSessionId)}/truncate`, { keep_count: userIndex })
        set({ history: { status: 'ready', data: history.data.slice(0, userIndex), fetchedAt: Date.now() }, liveTurn: null })
        get().send(user.text, { attachments: user.attachments })
        return true
      } catch (error) { set({ sessionError: errorMessage(error).error }); return false }
    },

    continueFrom: (messageId) => {
      const { history, liveTurn } = get()
      if (liveTurn && ['sending', 'streaming', 'stalled'].includes(liveTurn.status)) return false
      const bubbles = history.status === 'ready' ? history.data : []
      const assistant = bubbles.find(bubble => bubble.id === messageId && bubble.role === 'assistant')
      if (!assistant) return false
      const cutoff = assistant.text.trim().slice(-500)
      get().send(`Your previous response was interrupted. It ended with:\n\n${cutoff}\n\nDo not repeat what you already said. Continue exactly from where you were cut off.`)
      return true
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
      const queue = get().queuedSends[sessionId]
      if (!queue?.length) return null
      const [queued, ...remaining] = queue
      const queuedSends = { ...get().queuedSends }
      if (remaining.length) queuedSends[sessionId] = remaining
      else delete queuedSends[sessionId]
      set({ queuedSends })
      return queued
    },

    cancelQueued: (sessionId) => {
      const queue = get().queuedSends[sessionId]
      if (!queue?.length) return
      const queuedSends = { ...get().queuedSends }
      if (queue.length > 1) queuedSends[sessionId] = queue.slice(1)
      else delete queuedSends[sessionId]
      set({ queuedSends })
    },

    refreshActivity,

    startActivityWatch: () => {
      if (activityTimer) return
      void refreshActivity()
      activityTimer = setInterval(() => void refreshActivity(), 10_000)
    },

    stopActivityWatch: () => {
      if (activityTimer) clearInterval(activityTimer)
      activityTimer = null
      knownActive = null
    },

    enableNotifications: async () => {
      if (typeof Notification === 'undefined') return
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
      set({ notificationsEnabled: permission === 'granted' })
    },

    selectSession: async (id) => {
      // Detaching a reader does not stop its server-side turn. Task 1.5 will
      // reattach from the durable event log when this session is selected again.
      const pending = get().pendingSend
      if (pending && pending.sessionId !== id) {
        if (pendingTimer) clearTimeout(pendingTimer)
        pendingTimer = null
        set((state) => ({ pendingSend: null, queuedSends: { ...state.queuedSends, [pending.sessionId]: [...(state.queuedSends[pending.sessionId] ?? []), pending] } }))
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
      const { [id]: _cleared, ...sessionActivity } = get().sessionActivity
      set({ activeSessionId: id, liveTurn: null, branchPrefix, sessionActivity, usage: idle })
      await Promise.all([loadHistory(id), get().loadUsage(id)])
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
        set({ activeSessionId: null, history: idle, liveTurn: null, hasMore: false, nextCursor: null, usage: idle })
      }
    }),

    archiveSession: (id) => runSessionMutation(set, get, id, 'archiving', async () => {
      await apiJson<{ ok: boolean }>('POST', `/api/session/${encodeURIComponent(id)}/archive`)
      if (get().activeSessionId === id) {
        set({ activeSessionId: null, history: idle, liveTurn: null, hasMore: false, nextCursor: null, usage: idle })
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
        sessionId, text, opts, bubble: userBubble(text, opts.attachments), deadline: Date.now() + SEND_GRACE_MS,
      }
      if (isWorking() || get().pendingSend) {
        set((state) => ({ queuedSends: { ...state.queuedSends, [sessionId]: [...(state.queuedSends[sessionId] ?? []), buffered] } }))
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
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.events) || typeof snapshot.active !== 'boolean') return
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

useChatStore.subscribe(state => {
  localStorage.setItem('next:chat-queues', JSON.stringify(state.queuedSends))
  localStorage.setItem('next:chat-activity', JSON.stringify(state.sessionActivity))
  if (state.pendingSend) localStorage.setItem('next:chat-pending', JSON.stringify(state.pendingSend))
  else localStorage.removeItem('next:chat-pending')
})
