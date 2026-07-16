import { useEffect, useMemo, useState } from 'react'
import { Button, Card, EmptyState, ListRow, Modal, RemoteView, SectionHeader } from '../../kit'
import { useMemoryStore } from './store'
import type { MemoryItem } from './types'

export function MemoryTab() {
  const store = useMemoryStore()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<MemoryItem | null | undefined>(undefined)
  const [text, setText] = useState('')
  const [category, setCategory] = useState('User Curated')
  useEffect(() => { void store.load() }, [])
  const rows = useMemo(() => store.memory.status === 'ready' && Array.isArray(store.memory.data)
    ? store.memory.data.filter((item) => `${item.text} ${item.category}`.toLowerCase().includes(query.toLowerCase())) : [], [store.memory, query])
  const open = (item: MemoryItem | null) => { setEditing(item); setText(item?.text ?? ''); setCategory(item?.category ?? 'User Curated') }
  const save = async () => { if (editing) await store.save(editing, text, category); else await store.add(text, category); setEditing(undefined) }
  return <main className="next-tab"><SectionHeader title="Memory" actions={<Button onClick={() => open(null)}>Add memory</Button>} /><Card><input aria-label="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} /><RemoteView remote={store.memory} onRetry={store.load} empty={<EmptyState title="No memories" />}>{() => rows.map((item) => <ListRow key={item.id} title={`${item.pinned ? '★ ' : ''}${item.text}`} meta={item.category} onClick={() => open(item)} actions={<><Button variant="ghost" onClick={() => void store.pin(item)}>{item.pinned ? 'Unpin' : 'Pin'}</Button><Button variant="danger" onClick={() => { if (confirm('Delete this memory?')) void store.remove(item.id) }}>Delete</Button></>} />)}</RemoteView><p>Audit, extract, and import are available in the current app and are not built in /next yet.</p></Card><Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Edit memory' : 'Add memory'}><textarea value={text} onChange={(e) => setText(e.target.value)} /><input value={category} onChange={(e) => setCategory(e.target.value)} /><Button disabled={!text.trim()} onClick={() => void save()}>Save</Button></Modal></main>
}

