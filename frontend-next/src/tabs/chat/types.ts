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

export interface DefaultChat {
  endpoint_id: string
  endpoint_url: string
  model: string
}
