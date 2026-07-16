import { create } from 'zustand'
import { ApiError, apiDelete, apiForm, apiGet, apiJson, postStream } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import { applyEvent, emptyTurn, type Bubble, type Turn } from './reducer'
import { parseHistory } from './history'
import type { DefaultChat, HistoryResponse, ModelEndpoint, ModelsResponse, SessionRecord, StopResponse } from './types'

export interface SendOptions {
  allowWebSearch?: boolean
  attachments?: string[]
}

interface ChatState {
  sessions: Remote<SessionRecord[]>
  activeSessionId: string | null
  history: Remote<Bubble[]>
  hasMore: boolean
  nextCursor: string | null
  liveTurn: Turn | null
  models: Remote<ModelEndpoint[]>
  defaultChat: Remote<DefaultChat>
  pendingSessions: Record<string, string>
  sessionError: string | null
  loadSessions: () => Promise<void>
  loadModels: () => Promise<void>
  loadDefaultChat: () => Promise<void>
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
let historyEpoch = 0
let streamController: AbortController | null = null
let bubbleSequence = 0

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

  return {
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

    selectSession: async (id) => {
      // Detaching a reader does not stop its server-side turn. Task 1.5 will
      // reattach from the durable event log when this session is selected again.
      streamController?.abort()
      streamController = null
      set({ activeSessionId: id, liveTurn: null })
      await loadHistory(id)
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

      streamController?.abort()
      const turn = { ...emptyTurn(), bubbles: [userBubble(text)] }
      set({ liveTurn: turn })

      const form = new FormData()
      form.append('message', text)
      form.append('session', sessionId)
      if (opts.allowWebSearch) form.append('allow_web_search', 'true')
      if (opts.attachments?.length) form.append('attachments', JSON.stringify(opts.attachments))

      streamController = postStream('/api/chat_stream', form, {
        onEvent: (event) => {
          if (get().activeSessionId !== sessionId) return
          set((state) => ({ liveTurn: applyEvent(state.liveTurn ?? turn, event) }))
        },
        onDone: (sawDone) => {
          streamController = null
          if (get().activeSessionId !== sessionId) return
          if (!sawDone) {
            set((state) => ({
              liveTurn: state.liveTurn ? { ...state.liveTurn, status: 'error' } : null,
            }))
          }
          // The saved transcript is the authority; refresh rather than
          // synthesizing history records from the optimistic user bubble.
          void loadHistory(sessionId)
        },
        onError: () => {
          streamController = null
          if (get().activeSessionId !== sessionId) return
          set((state) => ({
            liveTurn: state.liveTurn ? { ...state.liveTurn, status: 'error' } : null,
          }))
        },
      })
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
