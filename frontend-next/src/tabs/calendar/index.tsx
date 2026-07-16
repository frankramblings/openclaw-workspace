import { useEffect, useState } from 'react'
import { Button, Card, EmptyState, ListRow, Modal, RemoteView, SectionHeader } from '../../kit'
import { monthWindow } from './logic'
import { useCalendarStore } from './store'
import type { CalendarEvent } from './types'
export function CalendarTab() {
  const store = useCalendarStore(), [quick, setQuick] = useState(''), [editing, setEditing] = useState<Partial<CalendarEvent> | null>(null)
  useEffect(() => { void store.load() }, [])
  const window = monthWindow(new Date(), store.offset)
  const save = async () => { if (!editing) return; await store.save(editing); setEditing(null) }
  return <main className="next-tab"><SectionHeader title="Calendar" actions={<><Button variant="ghost" onClick={() => void store.shift(-1)}>Previous</Button><Button variant="ghost" onClick={() => void store.load(0)}>Today</Button><Button variant="ghost" onClick={() => void store.shift(1)}>Next</Button><Button onClick={() => setEditing({ summary: '', dtstart: '', dtend: '', all_day: false })}>New event</Button></>} />
    <Card title={window.first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}><form onSubmit={(e) => { e.preventDefault(); void store.quick(quick) }}><input aria-label="Quick add" value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Lunch Friday at noon" /><Button type="submit">Parse</Button><Button variant="ghost" onClick={() => void store.syncNow()}>Sync</Button></form><RemoteView remote={store.sync}>{(_, remote = store.sync) => remote.status === 'ready' ? <small>Synced at {new Date(remote.fetchedAt).toLocaleTimeString()}</small> : null}</RemoteView></Card>
    <RemoteView remote={store.events} onRetry={store.load} empty={<EmptyState title="No events in this window" />} isEmpty={(r) => r.events.length === 0}>{(data) => <Card title="Events">{data.error && <p className="next-error">{data.error}</p>}{data.events.sort((a,b) => a.dtstart.localeCompare(b.dtstart)).map((event) => <ListRow key={`${event.calendar}:${event.uid}`} title={event.summary} meta={`${new Date(event.dtstart).toLocaleString()}${event.location ? ` · ${event.location}` : ''}`} onClick={() => setEditing(event)} actions={<Button variant="danger" onClick={() => void store.remove(event)}>Delete</Button>} />)}</Card>}</RemoteView>
    <RemoteView remote={store.parsed}>{(event) => <Card title="Parsed event"><p>{event.summary} · {event.dtstart}</p><Button onClick={() => setEditing(event)}>Review & create</Button></Card>}</RemoteView>
    <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing?.uid ? 'Edit event' : 'Create event'}>{editing && <><label>Title<input value={editing.summary ?? ''} onChange={(e) => setEditing({ ...editing, summary: e.target.value })} /></label><label>Starts<input value={editing.dtstart ?? ''} onChange={(e) => setEditing({ ...editing, dtstart: e.target.value })} /></label><label>Ends<input value={editing.dtend ?? ''} onChange={(e) => setEditing({ ...editing, dtend: e.target.value })} /></label><label>Location<input value={editing.location ?? ''} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></label><Button onClick={() => void save()}>Save</Button></>}</Modal>
  </main>
}

