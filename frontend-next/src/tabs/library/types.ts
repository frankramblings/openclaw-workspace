export type LibraryKind = 'chat' | 'document' | 'code' | 'note' | 'research'
export interface LibraryItem { id: string; kind: LibraryKind; title: string; snippet: string; updated: number; created?: number; count?: number; meta: string; archived?: boolean; content?: string }
export interface LibraryData { items: LibraryItem[]; sourceErrors: string[] }
export type LibraryDetail = { kind: 'chat'; messages: Array<{ role: string; content: string }>; model?: string | null } | { kind: 'document' | 'code' | 'note' | 'research'; markdown: string; sources?: Array<string | Record<string, unknown>> }
