import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Button, Card, EmptyState, Modal, RemoteView, SectionHeader } from '../../kit'
import { useChatStore } from '../chat/store'
import { actionLabel, ageLabelFor, primaryActions, swipeOutcome } from './logic'
import { useInboxStore } from './store'
import type { InboxItem } from './types'

const keyOf = (item: InboxItem) => `${item.source}:${item.id}`
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const list = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.map(object) : []

function Detail({ item, data }: { item: InboxItem; data: unknown }) {
  const detail = object(data)
  if (item.source === 'gmail') {
    const html = String(detail.body_html || detail.body || item.snippet || '')
    return <><div className="next-inbox-detail-meta"><strong>{String(detail.subject || item.title)}</strong><span>{String(detail.from_name || detail.from_address || item.subtitle || '')}</span><span>{String(detail.date || '')}</span></div>{detail.calendar && <pre className="next-inbox-calendar-card">{JSON.stringify(detail.calendar, null, 2)}</pre>}<iframe title="Email body" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={html} /></>
  }
  if (item.source === 'slack') return <div className="next-inbox-thread">{list(detail.messages).map((message, index) => <article key={String(message.ts || index)}><strong>{String(message.user || message.author || '?')}</strong><time>{String(message.time || '')}</time><p>{String(message.text || '')}</p></article>)}</div>
  if (item.source === 'asana') return <><div className="next-inbox-detail-meta"><strong>{String(detail.name || item.title)}</strong><span>{String(detail.assignee || '')}{detail.due ? ` · due ${String(detail.due)}` : ''}</span></div><p className="next-inbox-detail-copy">{String(detail.notes || item.snippet || '')}</p><div className="next-inbox-thread">{list(detail.comments).map((comment, index) => <article key={index}><strong>{String(comment.author || '?')}</strong><time>{String(comment.time || '')}</time><p>{String(comment.text || '')}</p></article>)}</div></>
  return <><p className="next-inbox-detail-copy">{item.snippet || item.subtitle || 'No preview supplied.'}</p><dl className="next-inbox-meta">{Object.entries(item.meta).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl></>
}

function SwipeCard({ item, children, primary, dismiss }: { item: InboxItem; children: ReactNode; primary(): void; dismiss(): void }) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const drag = useRef({ x: 0, y: 0 })
  const [offset, setOffset] = useState(0)
  const down = (event: ReactPointerEvent) => { if (event.pointerType !== 'mouse') start.current = { x: event.clientX, y: event.clientY } }
  const move = (event: ReactPointerEvent) => { if (!start.current) return; const x = event.clientX - start.current.x, y = event.clientY - start.current.y; drag.current = { x, y }; if (Math.abs(x) > Math.abs(y) && Math.abs(x) > 10) { event.currentTarget.setPointerCapture(event.pointerId); setOffset(Math.max(-130, Math.min(130, x))) } }
  const up = () => { const outcome = swipeOutcome(drag.current.x, drag.current.y); if (outcome === 'primary') primary(); else if (outcome === 'dismiss') dismiss(); setOffset(0); drag.current = { x: 0, y: 0 }; start.current = null }
  return <div className="next-inbox-swipe" data-key={keyOf(item)}><div className="next-inbox-swipe-under"><span>{actionLabel(primaryActions(item)[0] || 'dismiss')}</span><span>Dismiss</span></div><article className="next-inbox-item" style={{ transform: `translateX(${offset}px)` }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>{children}</article></div>
}

export function InboxTab() {
  const store = useInboxStore()
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [snooze, setSnooze] = useState<InboxItem | null>(null)
  const [configure, setConfigure] = useState<{ item: InboxItem; action: 'add_asana' | 'reclassify' } | null>(null)
  const [config, setConfig] = useState({ task: '', due: '', type: 'other' })
  useEffect(() => { void store.load() }, [])
  const feed = store.feed.status === 'ready' ? store.feed.data : null
  const rows = useMemo(() => (feed?.items ?? []).filter(item => (source === 'all' || item.source === source) && `${item.title} ${item.subtitle ?? ''} ${item.snippet ?? ''}`.toLowerCase().includes(query.toLowerCase())), [feed, query, source])
  const selectedItems = (feed?.items ?? []).filter(item => store.selection.includes(keyOf(item)))
  const handoff = async (input: InboxItem | InboxItem[], intent?: string) => {
    const id = await store.spinoff(input, intent)
    if (!id) return
    await useChatStore.getState().selectSession(id)
    location.hash = '#/chat'
  }
  const run = (item: InboxItem, action: string) => {
    if (action === 'gary' || action === 'reply') { void handoff(item, action); return }
    if (action === 'add_asana' || action === 'reclassify') { setConfig({ task: item.title, due: '', type: String(item.meta.guessType || 'other') }); setConfigure({ item, action }); return }
    void store.act(item, action)
  }
  const external = (item: InboxItem) => String(item.meta.url || (item.source === 'gmail' ? 'https://mail.google.com/mail/u/0/#inbox' : ''))
  return <main className="next-tab next-inbox-tab"><SectionHeader title={`Inbox${feed ? ` · ${feed.total}` : ''}`} actions={<><Button variant="ghost" onClick={() => setHistoryOpen(!historyOpen)}>History</Button><Button variant="ghost" disabled={store.triaging} onClick={() => void store.triage()}>{store.triaging ? 'Triaging…' : 'AI triage'}</Button><Button onClick={() => void store.load()}>Refresh</Button></>} />
    {store.error && <div className="next-inline-error" role="alert">{store.error}</div>}
    {store.notice && <div className="next-inbox-notice"><span>{store.notice.message}</span>{store.notice.undoTs && <Button variant="ghost" onClick={() => void store.undo(store.notice!.undoTs!)}>Undo</Button>}<Button variant="ghost" onClick={store.clearNotice}>×</Button></div>}
    {historyOpen ? <RemoteView remote={store.history} onRetry={store.load}>{history => <Card title="Recent actions">{history.entries.length ? history.entries.map(entry => <div className="next-inbox-history" key={entry.ts}><span className={`next-source next-source-${entry.source}`}>{entry.source}</span><strong>{actionLabel(entry.action)} · {entry.title}</strong>{entry.note && <small>{entry.note}</small>}{entry.undoable ? <Button variant="ghost" onClick={() => void store.undo(entry.ts)}>Undo</Button> : <span>not undoable</span>}</div>) : <EmptyState title="No recent actions" />}</Card>}</RemoteView> : <>
      <div className="next-inbox-toolbar"><input aria-label="Search inbox" placeholder="Search inbox…" value={query} onChange={event => setQuery(event.target.value)} /><div><button className={source === 'all' ? 'is-active' : ''} onClick={() => setSource('all')}>All {feed?.total ?? ''}</button>{feed && Object.entries(feed.sources).map(([name, count]) => <button key={name} className={source === name ? 'is-active' : ''} onClick={() => setSource(name)}>{name} {count}{feed.errors[name] ? ' ⚠' : ''}</button>)}</div></div>
      {store.selection.length > 0 && <div className="next-inbox-bulk"><strong>{store.selection.length} selected</strong><Button onClick={() => void handoff(selectedItems)}>Hand off together</Button><Button variant="ghost" onClick={() => selectedItems.forEach(item => store.toggleSelection(item))}>Clear</Button></div>}
      <div className={`next-inbox-layout${store.selected ? ' has-detail' : ''}`}><Card title={`Priority queue · ${rows.length}`}><RemoteView remote={store.feed} onRetry={store.load} empty={<EmptyState title="Inbox clear" hint="No items were returned by enabled sources." />} isEmpty={() => rows.length === 0}>{() => <div className="next-inbox-list">{rows.map(item => { const primary = primaryActions(item)[0] || 'dismiss', pending = store.pendingKey === keyOf(item); return <SwipeCard key={keyOf(item)} item={item} primary={() => run(item, item.rec?.action || primary)} dismiss={() => void store.act(item, 'dismiss')}><label className="next-inbox-select" onPointerDown={event => event.stopPropagation()}><input aria-label={`Select ${item.title}`} type="checkbox" checked={store.selection.includes(keyOf(item))} onChange={() => store.toggleSelection(item)} /></label><button className="next-inbox-main" disabled={pending} onClick={() => void store.select(item)}><span><span className={`next-source next-source-${item.source}`}>{item.source}</span><strong>{item.title}</strong><time>{ageLabelFor(item, feed!.generatedAt)}</time></span><small>{item.subtitle}</small>{item.snippet && <p>{item.snippet}</p>}{item.rec?.action && <em>✨ {actionLabel(item.rec.action)}{item.rec.reason ? ` — ${item.rec.reason}` : ''}</em>}</button><div className="next-inbox-actions" onPointerDown={event => event.stopPropagation()}>{primaryActions(item).map(action => <Button key={action} variant="ghost" disabled={pending} onClick={() => run(item, action)}>{actionLabel(action)}</Button>)}<Button variant="ghost" disabled={pending} onClick={() => setSnooze(item)}>Snooze</Button><Button variant="ghost" disabled={pending} onClick={() => void handoff(item)}>Hand off</Button>{external(item) && <a className="btn btn-ghost" href={external(item)} target="_blank" rel="noreferrer">Open</a>}<Button variant="ghost" disabled={pending} onClick={() => void store.act(item, 'dismiss')}>Dismiss</Button></div></SwipeCard> })}</div>}</RemoteView></Card>
        {store.selected && <Card title={store.selected.title} className="next-inbox-reader"><div className="next-inbox-reader-head"><Button variant="ghost" onClick={() => void store.select(null)}>← Back</Button><span className={`next-source next-source-${store.selected.source}`}>{store.selected.source}</span>{external(store.selected) && <a className="btn btn-ghost" href={external(store.selected)} target="_blank" rel="noreferrer">Open externally</a>}</div><RemoteView remote={store.detail} empty={<Detail item={store.selected} data={{}} />}>{detail => <Detail item={store.selected!} data={detail} />}</RemoteView></Card>}
      </div>
    </>}
    <Modal open={snooze !== null} onClose={() => setSnooze(null)} title="Snooze until"><div className="next-inbox-snooze">{[['Later today', 4 * 60 * 60 * 1000], ['Tomorrow morning', 0], ['Next week', 7 * 24 * 60 * 60 * 1000]].map(([label, delta]) => <Button key={String(label)} onClick={() => { if (!snooze) return; const date = new Date(); if (delta === 0) { date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0) } else date.setTime(date.getTime() + Number(delta)); void store.act(snooze, 'snooze', { until: date.getTime() }).then(ok => { if (ok) setSnooze(null) }) }}>{label}</Button>)}</div></Modal>
    <Modal open={configure !== null} onClose={() => setConfigure(null)} title={configure?.action === 'add_asana' ? 'Add task to Asana' : 'Classify entity'}>{configure && <div className="next-inbox-config">{configure.action === 'add_asana' ? <><label>Task<input value={config.task} onChange={event => setConfig({ ...config, task: event.target.value })} /></label><label>Due date<input type="date" value={config.due} onChange={event => setConfig({ ...config, due: event.target.value })} /></label></> : <label>Entity type<select value={config.type} onChange={event => setConfig({ ...config, type: event.target.value })}><option>person</option><option>company</option><option>project</option><option>place</option><option>other</option></select></label>}<Button onClick={() => void store.act(configure.item, configure.action, configure.action === 'add_asana' ? { task: config.task, due: config.due } : { type: config.type }).then(ok => { if (ok) setConfigure(null) })}>Confirm</Button></div>}</Modal>
  </main>
}
