import { useEffect, useMemo, useState } from 'react'
import { Button, Card, EmptyState, RemoteView, SectionHeader } from '../../kit'
import { useNotesStore } from './store'
import type { Note, NoteItem, NoteType } from './types'

const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple']
const makeItem = (): NoteItem => ({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text: '', done: false })
const copyNote = (note: Note): Note => ({ ...note, items: note.items?.map(item => ({ ...item })) })
const editable = (note: Note) => ({ title: note.title, content: note.content, note_type: note.note_type ?? 'note', items: note.items ?? [], color: note.color ?? '', label: note.label ?? null, due_date: note.due_date ?? null, repeat: note.repeat ?? 'none' })

function progress(note: Note) {
  if (note.note_type !== 'todo' && note.note_type !== 'goal') return ''
  const items = note.items ?? []
  return `${items.filter(item => item.done).length}/${items.length}`
}

function NoteEditor({ note }: { note: Note }) {
  const store = useNotesStore()
  const [draft, setDraft] = useState(() => copyNote(note))
  useEffect(() => setDraft(copyNote(note)), [note.id])
  useEffect(() => {
    if (JSON.stringify(editable(draft)) === JSON.stringify(editable(note))) return
    const timer = window.setTimeout(() => void store.save(note.id, draft), 700)
    return () => window.clearTimeout(timer)
  }, [draft, note])
  const updateItem = (index: number, patch: Partial<NoteItem>) => setDraft({ ...draft, items: (draft.items ?? []).map((item, at) => at === index ? { ...item, ...patch } : item) })
  const setType = (note_type: NoteType) => setDraft({
    ...draft,
    note_type,
    items: note_type === 'note' ? draft.items : (draft.items?.length ? draft.items : [makeItem()]),
  })
  return <Card title="Editor" className={`next-note-editor next-note-color-${draft.color || 'default'}`}>
    <div className="next-note-editor-head"><input aria-label="Note title" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /><Button variant="ghost" onClick={() => void store.togglePin(note)}>{note.pinned ? 'Unpin' : 'Pin'}</Button></div>
    <div className="next-note-types" role="group" aria-label="Note type">{(['note', 'todo', 'goal'] as NoteType[]).map(type => <Button key={type} variant={draft.note_type === type ? 'primary' : 'ghost'} onClick={() => setType(type)}>{type === 'note' ? 'Note' : type === 'todo' ? 'Todo' : 'Goal'}</Button>)}</div>
    {draft.note_type === 'note' || !draft.note_type
      ? <textarea aria-label="Note content" value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} />
      : <div className="next-note-checklist">{(draft.items ?? []).map((item, index) => <div key={item.id}><input aria-label={`Complete ${item.text || `item ${index + 1}`}`} type="checkbox" checked={item.done} onChange={event => updateItem(index, { done: event.target.checked })} /><input aria-label={`Checklist item ${index + 1}`} value={item.text} onChange={event => updateItem(index, { text: event.target.value })} /><Button variant="ghost" onClick={() => setDraft({ ...draft, items: draft.items?.filter((_, at) => at !== index) })}>×</Button></div>)}<Button variant="ghost" onClick={() => setDraft({ ...draft, items: [...(draft.items ?? []), makeItem()] })}>Add item</Button></div>}
    {draft.note_type === 'goal' && <textarea aria-label="Goal description" value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} placeholder="What does success look like?" />}
    <div className="next-note-fields"><label>Tags<input value={draft.label ?? ''} onChange={event => setDraft({ ...draft, label: event.target.value || null })} placeholder="work urgent" /></label><label>Reminder<input type="datetime-local" value={draft.due_date ?? ''} onChange={event => setDraft({ ...draft, due_date: event.target.value || null })} /></label><label>Repeat<select value={draft.repeat ?? 'none'} onChange={event => setDraft({ ...draft, repeat: event.target.value })}><option value="none">Never</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label></div>
    <div className="next-note-colors" aria-label="Note color">{COLORS.map(color => <button key={color || 'default'} aria-label={color || 'default'} aria-pressed={(draft.color ?? '') === color} className={`next-note-swatch next-note-color-${color || 'default'}`} onClick={() => setDraft({ ...draft, color })} />)}</div>
    <div className="next-note-actions"><span aria-live="polite">{store.saveState}</span><Button onClick={() => void store.save(note.id, draft)}>Save now</Button>{draft.due_date && <Button variant="ghost" onClick={() => void store.fireReminder(draft)}>Test reminder</Button>}<Button variant="ghost" onClick={() => void store.archive(note)}>{note.archived ? 'Unarchive' : 'Archive'}</Button><Button variant="danger" onClick={() => { if (confirm('Delete this note permanently?')) void store.remove(note.id) }}>Delete</Button></div>
  </Card>
}

export function NotesTab() {
  const store = useNotesStore()
  const [query, setQuery] = useState('')
  const [type, setType] = useState<'all' | NoteType>('all')
  useEffect(() => { void (async () => { await store.load(); const state = useNotesStore.getState(); if (!state.selected && state.notes.status === 'ready' && state.notes.data.notes[0]) state.select(state.notes.data.notes[0]) })() }, [])
  const rows = store.notes.status === 'ready' ? store.notes.data.notes : []
  const filtered = useMemo(() => rows.filter(note => {
    const haystack = `${note.title} ${note.content} ${note.label ?? ''} ${(note.items ?? []).map(item => item.text).join(' ')}`.toLowerCase()
    return haystack.includes(query.toLowerCase()) && (type === 'all' || (note.note_type ?? 'note') === type)
  }), [query, rows, type])
  return <main className="next-tab next-notes-tab"><SectionHeader title="Notes" actions={<><Button variant="ghost" onClick={() => void store.load()}>Refresh</Button><Button onClick={() => void store.create()}>New note</Button><Button variant="ghost" onClick={() => void store.create('todo')}>New todo</Button></>} />
    {store.error && <div role="alert" className="next-inline-error">{store.error}</div>}
    <div className="next-note-toolbar"><input aria-label="Search notes" placeholder="Search notes…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Filter note type" value={type} onChange={event => setType(event.target.value as typeof type)}><option value="all">All types</option><option value="note">Notes</option><option value="todo">Todos</option><option value="goal">Goals</option></select><label><input type="checkbox" checked={store.archived} onChange={event => { store.select(null); void store.load(event.target.checked) }} /> Archived</label></div>
    <div className="next-notes-layout"><Card title={`${store.archived ? 'Archived' : 'Active'} · ${filtered.length}`}><RemoteView remote={store.notes} onRetry={store.load} empty={<EmptyState title="No notes" />} isEmpty={() => filtered.length === 0}>{() => <div className="next-note-cards">{filtered.map((note, index) => <article key={note.id} className={`next-note-card next-note-color-${note.color || 'default'}${store.selected?.id === note.id ? ' is-selected' : ''}`} onClick={() => store.select(note)}><div><strong>{note.pinned ? '★ ' : ''}{note.title || 'Untitled'}</strong><span>{progress(note)}</span></div>{note.note_type === 'todo' || note.note_type === 'goal' ? <ul>{(note.items ?? []).slice(0, 4).map(item => <li key={item.id} className={item.done ? 'is-done' : ''}>[{item.done ? '×' : ' '}] {item.text}</li>)}</ul> : <p>{note.content.slice(0, 180)}</p>}<small>{note.label ? `#${note.label.replace(/\s+/g, ' #')} · ` : ''}{note.updated ?? ''}</small><div><Button variant="ghost" disabled={index === 0 || store.pending === note.id} onClick={() => void store.move(note.id, -1)}>↑</Button><Button variant="ghost" disabled={index === filtered.length - 1 || store.pending === note.id} onClick={() => void store.move(note.id, 1)}>↓</Button><Button variant="ghost" disabled={store.pending === note.id} onClick={() => void store.togglePin(note)}>{note.pinned ? 'Unpin' : 'Pin'}</Button></div></article>)}</div>}</RemoteView></Card>
      {store.selected ? <NoteEditor key={store.selected.id} note={store.selected} /> : <Card title="Editor"><EmptyState title="Select a note" hint="Choose a card or create a note or todo." /></Card>}
    </div>
  </main>
}
