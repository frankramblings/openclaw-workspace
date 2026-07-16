import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, EmptyState, Modal, RemoteView, SectionHeader } from '../../kit'
import { useMemoryStore } from './store'
import type { MemoryItem } from './types'

type Sort = 'newest' | 'oldest' | 'alpha' | 'uses'
const formatDate = (value: number) => value ? new Date(value).toLocaleDateString() : 'Unknown date'

export function MemoryTab() {
  const store = useMemoryStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [sort, setSort] = useState<Sort>('newest')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<MemoryItem | null | undefined>(undefined)
  const [text, setText] = useState('')
  const [category, setCategory] = useState('User Curated')
  const [session, setSession] = useState('')
  useEffect(() => { void store.load() }, [])
  const all = store.memory.status === 'ready' ? store.memory.data : []
  const categories = useMemo(() => [...new Set(all.map(item => item.category || 'fact'))].sort(), [all])
  const rows = useMemo(() => all.filter(item => `${item.text} ${item.category} ${item.source}`.toLowerCase().includes(query.toLowerCase()) && (categoryFilter === 'all' || item.category === categoryFilter)).sort((a, b) => sort === 'oldest' ? a.timestamp - b.timestamp : sort === 'alpha' ? a.text.localeCompare(b.text) : sort === 'uses' ? b.uses - a.uses : b.timestamp - a.timestamp), [all, query, categoryFilter, sort])
  const sessions = store.sessions.status === 'ready' ? store.sessions.data : []
  const open = (item: MemoryItem | null) => { setEditing(item); setText(item?.text ?? ''); setCategory(item?.category ?? 'User Curated') }
  const save = async () => { const ok = editing ? await store.save(editing, text, category) : await store.add(text, category); if (ok) setEditing(undefined) }
  const toggle = (id: string) => setSelected(value => { const next = new Set(value); next.has(id) ? next.delete(id) : next.add(id); return next })
  const exportAll = () => { const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'memories.json'; anchor.click(); URL.revokeObjectURL(url) }
  const removeSelected = async () => { if (!selected.size || !confirm(`Delete ${selected.size} memories?`)) return; await store.removeMany([...selected]); setSelected(new Set()) }
  return <main className="next-tab next-memory-tab"><SectionHeader title={`Memory · ${all.length}`} actions={<><Button variant="ghost" onClick={exportAll} disabled={!all.length}>Export</Button><Button onClick={() => open(null)}>Add memory</Button></>} />
    {store.error && <div className="next-inline-error" role="alert">{store.error}</div>}
    {store.auditResult && <div className="next-memory-audit" role="status">Tidy complete: {store.auditResult.removed || 0} removed ({store.auditResult.before ?? all.length} → {store.auditResult.after ?? all.length}).</div>}
    <div className="next-memory-toolbar"><input aria-label="Search memory" placeholder="Search memories…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Sort memory" value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="alpha">A–Z</option><option value="uses">Most used</option></select><Button variant="ghost" disabled={store.pending === 'audit'} onClick={() => void store.audit()}>{store.pending === 'audit' ? 'Tidying…' : 'Tidy'}</Button></div>
    <div className="next-memory-categories"><button className={categoryFilter === 'all' ? 'is-active' : ''} onClick={() => setCategoryFilter('all')}>all · {all.length}</button>{categories.map(value => <button key={value} className={categoryFilter === value ? 'is-active' : ''} onClick={() => setCategoryFilter(value)}>{value} · {all.filter(item => item.category === value).length}</button>)}</div>
    <Card>{selected.size > 0 && <div className="next-memory-bulk"><label><input type="checkbox" checked={rows.length > 0 && rows.every(item => selected.has(item.id))} onChange={event => setSelected(event.target.checked ? new Set(rows.map(item => item.id)) : new Set())} /> All visible</label><strong>{selected.size} selected</strong><Button variant="danger" disabled={store.pending === 'bulk-delete'} onClick={() => void removeSelected()}>Delete</Button><Button variant="ghost" onClick={() => setSelected(new Set())}>Cancel</Button></div>}
      <RemoteView remote={store.memory} onRetry={store.load} empty={<EmptyState title="No memories" hint="Add a durable fact or import a file to get started." />} isEmpty={() => rows.length === 0}>{() => <div className="next-memory-list">{rows.map(item => <article key={item.id} className={selected.has(item.id) ? 'is-selected' : ''}><input aria-label={`Select ${item.text}`} type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} /><button className="next-memory-content" onClick={() => open(item)}><strong>{item.pinned && '★ '}{item.text}</strong><span><em>{item.category || 'fact'}</em> · {item.source || 'memory'} · {formatDate(item.timestamp)} · used {item.uses || 0}</span></button><div><Button variant="ghost" disabled={store.pending === item.id} onClick={() => void store.pin(item)}>{item.pinned ? 'Unpin' : 'Pin'}</Button><Button variant="ghost" onClick={() => open(item)}>Edit</Button><Button variant="danger" disabled={store.pending === item.id} onClick={() => { if (confirm('Delete this memory?')) void store.remove(item.id) }}>Delete</Button></div></article>)}</div>}</RemoteView>
    </Card>
    <Card title="Extract or import"><p>Review AI-suggested memories before saving anything.</p><div className="next-memory-import"><select aria-label="Conversation for extraction" value={session} onChange={event => setSession(event.target.value)}><option value="">Choose a conversation…</option>{sessions.map(value => <option key={value.id} value={value.id}>{value.name || value.id}</option>)}</select><Button variant="ghost" disabled={!session || store.pending === 'extract'} onClick={() => void store.extract(session)}>{store.pending === 'extract' ? 'Extracting…' : 'Extract conversation'}</Button><input ref={fileRef} type="file" hidden accept=".txt,.md,.pdf,.csv,.log,.json,.py,.js,.html" onChange={event => { const file = event.target.files?.[0]; if (file) void store.importFile(file, session || undefined); event.currentTarget.value = '' }} /><Button variant="ghost" disabled={store.pending === 'import'} onClick={() => fileRef.current?.click()}>{store.pending === 'import' ? 'Importing…' : 'Import file'}</Button></div>
      {store.suggestionSource && <div className="next-memory-review"><header><strong>{store.suggestionSource} · {store.suggestions.length} suggestions</strong><div><Button disabled={!store.suggestions.length || store.pending === 'save-suggestions'} onClick={() => void store.saveSuggestions()}>Save all</Button><Button variant="ghost" onClick={store.clearSuggestions}>Close</Button></div></header>{store.suggestions.length ? store.suggestions.map(item => <article key={item.id}><div><strong>{item.text}</strong><span>{item.category}</span></div><Button variant="ghost" disabled={store.pending !== null} onClick={() => void store.saveSuggestion(item.id)}>Save</Button><Button variant="danger" onClick={() => store.dismissSuggestion(item.id)}>Dismiss</Button></article>) : <EmptyState title="No useful information found" />}</div>}
    </Card>
    <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Edit memory' : 'Add memory'}><div className="next-memory-editor"><label>Memory<textarea aria-label="Memory text" value={text} onChange={event => setText(event.target.value)} /></label><label>Category<input aria-label="Memory category" list="next-memory-category-options" value={category} onChange={event => setCategory(event.target.value)} /></label><datalist id="next-memory-category-options">{categories.map(value => <option key={value} value={value} />)}</datalist><div><Button variant="ghost" onClick={() => setEditing(undefined)}>Cancel</Button><Button disabled={!text.trim() || store.pending !== null} onClick={() => void save()}>{store.pending ? 'Saving…' : 'Save'}</Button></div></div></Modal>
  </main>
}
