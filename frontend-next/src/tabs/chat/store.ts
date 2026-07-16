import { create } from 'zustand'
import { ApiError, apiGet, apiJson, postStream } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import { applyEvent, emptyTurn, type Bubble, type Turn } from './reducer'
import type { HistoryItem, HistoryResponse, ModelEndpoint, ModelsResponse, SessionRecord, StopResponse } from './types'

export interface SendOptions {
  allowWebSearch?: boolean
  attachments?: string[]
}

interface ChatState {
  sessions: Remote<SessionRecord[]>
  activeSessionId: string | null
  history: Remote<HistoryItem[]>
  hasMore: boolean
  nextCursor: string | null
  liveTurn: Turn | null
  models: Remote<ModelEndpoint[]>
  loadSessions: () => Promise<void>
  loadModels: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  loadOlder: () => Promise<void>
  send: (text: string, opts?: SendOptions) => void
  stop: () => Promise<void>
}

const sessionsLoader = makeLoader<SessionRecord[]>()
const modelsLoader = makeLoader<ModelEndpoint[]>()
let historyEpoch = 0
let streamController: AbortController | null = null
let bubbleSequence = 0

function errorMessage(error: unknown): { error: string; httpStatus?: number } {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ApiError ? { httpStatus: error.status } : {}),
  }
}

function staleHistory(remote: Remote<HistoryItem[]>): HistoryItem[] | undefined {
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
        history: { status: 'ready', data: page.history, fetchedAt: Date.now() },
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

    loadSessions: () => sessionsLoader(
      () => apiGet<SessionRecord[]>('/api/sessions'),
      (sessions) => set({ sessions }),
      get().sessions,
    ),

    loadModels: () => modelsLoader(
      async () => (await apiGet<ModelsResponse>('/api/models')).items,
      (models) => set({ models }),
      get().models,
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
          history: { status: 'ready', data: [...page.history, ...current], fetchedAt: Date.now() },
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        })
      } catch (error) {
        if (epoch !== historyEpoch || get().activeSessionId !== activeSessionId) return
        set({ history: { status: 'error', ...errorMessage(error), stale: current } })
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
