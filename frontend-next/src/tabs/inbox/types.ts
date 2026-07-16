export interface InboxItem {
  id: string
  source: string
  title: string
  subtitle?: string
  snippet?: string
  ts?: number | string
  score: number
  meta: Record<string, unknown>
  actions: string[]
  rec?: { action?: string; reason?: string; by?: string; confidence?: string }
}

export interface ItemsResponse {
  items: InboxItem[]
  total: number
  sources: Record<string, number>
  errors: Record<string, string>
  generatedAt: number
}

export interface ActionResponse { ok: boolean; undoTs?: number; error?: string }
export interface HistoryEntry { ts: number; source: string; id: string; title: string; action: string; undoable: boolean; note?: string }
export interface HistoryResponse { entries: HistoryEntry[] }
export interface ItemActionOptions { until?: number; type?: string; task?: string; due?: string; response?: string }
export interface SpinoffResponse { session_id: string; count?: number; deduped?: boolean }
