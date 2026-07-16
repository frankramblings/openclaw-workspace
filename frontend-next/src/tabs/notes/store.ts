import { create } from 'zustand'
import { apiDelete, apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { Note, NotesResponse } from './types'

interface NotesState {
  notes: Remote<NotesResponse>
  selected: Note | null
  archived: boolean
  pending: string | null
  saveState: 'idle' | 'saving' | 'saved' | 'failed'
  error: string | null
  load(archived?: boolean): Promise<void>
  select(note: Note | null): void
  create(type?: Note['note_type']): Promise<void>
  save(id: string, patch: Partial<Note>): Promise<boolean>
  togglePin(note: Note): Promise<void>
  archive(note: Note): Promise<void>
  remove(id: string): Promise<void>
  move(id: string, delta: number): Promise<void>
  fireReminder(note: Note): Promise<void>
}

const loader = makeLoader<NotesResponse>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export const useNotesStore = create<NotesState>((set, get) => {
  const load = async (archived = get().archived) => {
    set({ archived })
    await loader(
      () => apiGet(`/api/notes?archived=${archived}`),
      notes => set({ notes }),
      get().notes,
    )
  }
  const mutate = async (id: string, operation: () => Promise<unknown>) => {
    set({ pending: id, error: null })
    try {
      await operation()
      await load()
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ pending: null })
    }
  }
  return {
    notes: idle,
    selected: null,
    archived: false,
    pending: null,
    saveState: 'idle',
    error: null,
    load,
    select: selected => set({ selected, saveState: 'idle', error: null }),
    create: async (type = 'note') => {
      set({ pending: 'new', error: null })
      try {
        const note = await apiJson<Note>('POST', '/api/notes', {
          title: 'Untitled note',
          content: '',
          note_type: type,
          items: type === 'note' ? undefined : [],
          pinned: false,
          archived: false,
          color: '',
          label: null,
          due_date: null,
          repeat: 'none',
        })
        await load(false)
        set({ selected: note, saveState: 'saved' })
      } catch (error) {
        set({ error: message(error) })
      } finally {
        set({ pending: null })
      }
    },
    save: async (id, patch) => {
      set({ saveState: 'saving', error: null })
      try {
        const note = await apiJson<Note>('PUT', `/api/notes/${encodeURIComponent(id)}`, patch)
        set(state => ({
          selected: state.selected?.id === id ? note : state.selected,
          notes: state.notes.status === 'ready' ? {
            status: 'ready',
            data: { notes: state.notes.data.notes.map(item => item.id === id ? note : item) },
            fetchedAt: Date.now(),
          } : state.notes,
          saveState: 'saved',
        }))
        return true
      } catch (error) {
        set({ saveState: 'failed', error: message(error) })
        return false
      }
    },
    togglePin: note => mutate(note.id, async () => {
      const saved = await apiJson<Note>('PUT', `/api/notes/${encodeURIComponent(note.id)}`, { pinned: !note.pinned })
      if (get().selected?.id === note.id) set({ selected: saved })
    }),
    archive: note => mutate(note.id, async () => {
      await apiJson<Note>('PUT', `/api/notes/${encodeURIComponent(note.id)}`, { archived: !note.archived })
      if (get().selected?.id === note.id) set({ selected: null })
    }),
    remove: id => mutate(id, async () => {
      await apiDelete(`/api/notes/${encodeURIComponent(id)}`)
      if (get().selected?.id === id) set({ selected: null })
    }),
    move: async (id, delta) => {
      const remote = get().notes
      if (remote.status !== 'ready') return
      const ids = remote.data.notes.map(note => note.id)
      const from = ids.indexOf(id)
      const to = Math.max(0, Math.min(ids.length - 1, from + delta))
      if (from < 0 || from === to) return
      ids.splice(to, 0, ...ids.splice(from, 1))
      await mutate(id, async () => {
        const result = await apiJson<{ ok: boolean }>('POST', '/api/notes/reorder', { ids })
        if (!result.ok) throw new Error('Reorder failed')
      })
    },
    fireReminder: note => mutate(note.id, () => apiJson('POST', '/api/notes/fire-reminder', {
      note_id: note.id,
      title: note.title || 'Note reminder',
      body: note.note_type === 'todo'
        ? (note.items ?? []).filter(item => !item.done).map(item => `- ${item.text}`).join('\n')
        : note.content.slice(0, 400),
    })),
  }
})
