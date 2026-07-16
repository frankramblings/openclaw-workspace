export interface Note { id: string; title: string; content: string; pinned?: boolean; archived?: boolean; updated?: string; sort?: number }
export interface NotesResponse { notes: Note[] }

