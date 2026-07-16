export interface NoteItem {
  id: string
  text: string
  done: boolean
}

export type NoteType = 'note' | 'todo' | 'goal'

export interface Note {
  id: string
  title: string
  content: string
  note_type?: NoteType
  items?: NoteItem[]
  pinned?: boolean
  archived?: boolean
  color?: string
  label?: string | null
  due_date?: string | null
  repeat?: string
  image_url?: string | null
  created?: string
  updated?: string
  sort?: number
  sort_order?: number
}

export interface NotesResponse { notes: Note[] }
