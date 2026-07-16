export interface MemoryItem { id: string; text: string; category: string; pinned: boolean; timestamp: number; uses: number; source: string }
export interface MemorySuggestion { id: string; text: string; category: string; selected: boolean }
export interface MemorySession { id: string; name?: string; updated?: number }
export interface AuditResult { before?: number; after?: number; removed?: number }
