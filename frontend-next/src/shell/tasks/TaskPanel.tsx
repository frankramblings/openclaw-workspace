import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, RemoteView } from '../../kit'
import { useTaskPanel } from './store'
import { useHistoryLayer } from '../useHistoryLayer'

const age = (value: number) => { const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago` }

export function TaskPanel() {
  const store = useTaskPanel()
  const close = useHistoryLayer(store.open, store.close)
  const [filter, setFilter] = useState('all')
  useEffect(() => { void store.load(); return store.watch() }, [])
  const tasks = store.tasks.status === 'ready' ? store.tasks.data : []
  const rows = useMemo(() => tasks.filter(task => filter === 'all' || (filter === 'active' ? task.state === 'running' || task.state === 'stalled' : task.state === filter)), [filter, tasks])
  const selected = tasks.find(task => task.id === store.selected)
  if (!store.open) return null
  return <aside className="next-task-panel" aria-label="Task feed"><header><strong>Tasks · {tasks.length}</strong><span className={`next-stream-status is-${store.streamStatus}`}>{store.streamStatus}</span><Button variant="ghost" onClick={() => void store.load()}>Refresh</Button><Button variant="ghost" onClick={close}>Close</Button></header><div className="next-task-filters"><button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'active' ? 'is-active' : ''} onClick={() => setFilter('active')}>Active</button><button className={filter === 'done' ? 'is-active' : ''} onClick={() => setFilter('done')}>Done</button><button className={filter === 'failed' ? 'is-active' : ''} onClick={() => setFilter('failed')}>Failed</button></div><div className={`next-task-body${selected ? ' has-detail' : ''}`}><section><RemoteView remote={store.tasks} onRetry={store.load} empty={<EmptyState title="No background tasks" hint="Research, follow-ups and background jobs appear here while active and briefly after completion." />} isEmpty={() => rows.length === 0}>{() => <div className="next-task-list">{rows.map(task => <button key={task.id} className={`is-${task.state}${store.selected === task.id ? ' is-selected' : ''}`} onClick={() => store.select(task.id)}><span className={`next-job-dot is-${task.state}`} /><strong>{task.label || task.kind || task.id}</strong><em>{task.state} · {age(task.updated)}</em><small>{task.detail || task.error || task.source}</small>{task.pct != null && <progress max={100} value={task.pct} />}</button>)}</div>}</RemoteView></section>{selected && <section className="next-task-detail"><Button variant="ghost" onClick={() => store.select(null)}>← Back</Button><h3>{selected.label || selected.kind}</h3><dl><div><dt>Status</dt><dd>{selected.state}</dd></div><div><dt>Source</dt><dd>{selected.source} · {selected.kind}</dd></div><div><dt>Updated</dt><dd>{new Date(selected.updated).toLocaleString()}</dd></div>{selected.eta != null && <div><dt>ETA</dt><dd>{selected.eta}s</dd></div>}</dl>{selected.detail && <p>{selected.detail}</p>}{selected.error && <div className="next-inline-error">{selected.error}</div>}{selected.tail && <pre>{selected.tail}</pre>}{selected.extra && Object.keys(selected.extra).length > 0 && <details><summary>Metadata</summary><pre>{JSON.stringify(selected.extra, null, 2)}</pre></details>}</section>}</div></aside>
}
