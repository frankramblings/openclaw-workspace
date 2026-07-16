export interface SessionRecord {
  id: string
  name: string
  model: string
  speed: 'fast' | 'normal' | 'deep'
  sessionKey: string
  endpoint_url: string
  endpoint_id: string
  folder: string | null
  archived: boolean
  important: boolean
  created: number
  updated: number
  origin: string | null
  gary_terminal: boolean | null
}

export interface HistoryItem {
  role: string
  content: unknown
  attachments?: unknown[]
  metadata?: Record<string, unknown>
}

export interface HistoryResponse {
  history: HistoryItem[]
  model: string | null
  hasMore: boolean
  nextCursor: string | null
}

export interface ModelEndpoint {
  endpoint_id: string
  endpoint_name: string
  url: string
  category: string
  model_type: string
  offline: boolean
  models: string[]
  models_display: string[]
  models_extra: string[]
  models_extra_display: string[]
}

export interface ModelsResponse {
  items: ModelEndpoint[]
}

export interface StopResponse {
  ok: boolean
  runIds: string[]
}

export interface SearchHit {
  session_id: string
  session_name: string
  role: 'user' | 'assistant'
  content_snippet: string
  timestamp: string
  score: number
}

export interface BranchResponse {
  session_id: string
  session_key: string
  prefix: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
}

export interface DefaultChat {
  endpoint_id: string
  endpoint_url: string
  model: string
}

export interface SessionUsage {
  ok: boolean
  sessionId: string
  model: string
  modelProvider: string
  usage: {
    totalTokens: number
    totalCost: number
    inputTokens: number
    outputTokens: number
    messages: number
    toolCalls: number
    errors: number
  }
  context: {
    usedTokens: number
    windowTokens: number
    usedPct: number
    contextWindowSource: string
    live: boolean
    systemPromptChars: number
    systemPromptTokens: number
    tokenEstimate: boolean
  }
  updatedAt: string
}
