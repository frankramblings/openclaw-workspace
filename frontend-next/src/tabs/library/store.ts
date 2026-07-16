import { create } from 'zustand'
import { apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { SessionRecord } from '../chat/types'
import type { DocumentFull, DocumentLibrary } from '../documents/types'
import type { Note, NotesResponse } from '../notes/types'
import type { ResearchLibrary, ResearchResult } from '../research/types'
import type { LibraryData, LibraryDetail, LibraryItem } from './types'

interface LibraryState { library: Remote<LibraryData>; detail: Remote<LibraryDetail>; selected: string | null; pending: string | null; error: string | null; load(): Promise<void>; open(item: LibraryItem): Promise<void>; restore(item: LibraryItem): Promise<boolean>; close(): void }
const libraryLoader = makeLoader<LibraryData>(), detailLoader = makeLoader<LibraryDetail>()
const toMs = (value: unknown) => { if (typeof value === 'number') return value < 1e12 ? value * 1000 : value; const parsed = Date.parse(String(value || '')); return Number.isNaN(parsed) ? 0 : parsed }
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).filter(Boolean).join('\n') : value && typeof value === 'object' ? text((value as { text?: unknown }).text ?? (value as { content?: unknown }).content ?? '') : ''
const safe = async <T>(name: string, work: () => Promise<T>) => { try { return { name, ok: true as const, value: await work() } } catch { return { name, ok: false as const, value: null } } }

export const useLibraryStore = create<LibraryState>((set, get) => {
  const load = () => libraryLoader(async () => {
    const [documents, research, activeNotes, archivedNotes, sessions] = await Promise.all([
      safe('documents', () => apiGet<DocumentLibrary>('/api/documents/library?sort=recent&limit=200')),
      safe('research', () => apiGet<ResearchLibrary>('/api/research/library?limit=200')),
      safe('notes', () => apiGet<NotesResponse>('/api/notes?archived=false')),
      safe('archived notes', () => apiGet<NotesResponse>('/api/notes?archived=true')),
      safe('chats', () => apiGet<SessionRecord[]>('/api/sessions')),
    ])
    const results = [documents, research, activeNotes, archivedNotes, sessions]
    if (results.every(result => !result.ok)) throw new Error('All library sources failed')
    const items: LibraryItem[] = []
    if (documents.ok) for (const item of documents.value.documents || []) items.push({ id: item.id, kind: ['js', 'javascript', 'ts', 'typescript', 'python', 'json', 'html', 'css', 'sql', 'bash', 'sh'].includes((item.language || '').toLowerCase()) ? 'code' : 'document', title: item.title || 'Untitled document', snippet: item.preview || '', updated: toMs(item.updated_at), count: item.version_count, meta: `${item.language || 'text'} · ${item.version_count || 1} versions` })
    if (research.ok) for (const item of research.value.research || []) items.push({ id: item.id, kind: 'research', title: item.query || 'Untitled research', snippet: `${item.source_count || 0} sources${item.rounds ? ` · ${item.rounds} rounds` : ''}`, updated: toMs(item.started_at), count: item.source_count, meta: `${item.status}${item.category ? ` · ${item.category}` : ''}` })
    const noteValues: Note[] = [...(activeNotes.ok ? activeNotes.value.notes || [] : []), ...(archivedNotes.ok ? archivedNotes.value.notes || [] : [])]
    for (const item of noteValues) items.push({ id: item.id, kind: 'note', title: item.title || 'Untitled note', snippet: item.content || item.items?.map(value => `${value.done ? '✓' : '○'} ${value.text}`).join('\n') || '', content: item.content || '', updated: toMs(item.updated), created: toMs(item.created), count: item.items?.length, meta: `${item.note_type || 'note'}${item.label ? ` · ${item.label}` : ''}${item.archived ? ' · archived' : ''}`, archived: item.archived })
    if (sessions.ok) for (const item of sessions.value || []) items.push({ id: item.id, kind: 'chat', title: item.name || 'Untitled chat', snippet: '', updated: toMs(item.updated), created: toMs(item.created), meta: `${item.model || 'default model'}${item.folder ? ` · ${item.folder}` : ''}${item.archived ? ' · archived' : ''}`, archived: item.archived })
    return { items: items.sort((a, b) => b.updated - a.updated), sourceErrors: results.filter(result => !result.ok).map(result => result.name) }
  }, library => set({ library }), get().library)
  return {
    library: idle, detail: idle, selected: null, pending: null, error: null, load,
    open: async item => {
      set({ selected: `${item.kind}:${item.id}`, error: null })
      await detailLoader(async () => {
        if (item.kind === 'chat') { const value = await apiGet<{ history?: Array<{ role?: string; content?: unknown }>; model?: string | null }>(`/api/history/${encodeURIComponent(item.id)}?limit=40`); return { kind: 'chat', messages: (value.history || []).map(message => ({ role: message.role || 'message', content: text(message.content) })).filter(message => message.content), model: value.model } }
        if (item.kind === 'research') { const value = await apiJson<ResearchResult>('POST', `/api/research/result-peek/${encodeURIComponent(item.id)}`, {}); return { kind: 'research', markdown: value.result || '', sources: value.sources || [] } }
        if (item.kind === 'note') return { kind: 'note', markdown: item.content || item.snippet }
        const value = await apiGet<DocumentFull>(`/api/document/${encodeURIComponent(item.id)}`); return { kind: item.kind, markdown: value.current_content || '' }
      }, detail => set({ detail }), get().detail)
    },
    restore: async item => { set({ pending: item.id, error: null }); try { await apiJson('POST', `/api/session/${encodeURIComponent(item.id)}/restore`); await load(); return true } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return false } finally { set({ pending: null }) } },
    close: () => set({ selected: null, detail: idle }),
  }
})
