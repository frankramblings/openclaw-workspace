import { useEffect, useState } from 'react'
import { Button, EmptyState, ListRow, Modal, RemoteView, SectionHeader } from '../../kit'
import { Icon } from '../../kit/icons'
import { useChatStore } from './store'
import { usePaletteStore } from '../../shell/palette/store'

export function SessionList({ onSelected }: { onSelected?: () => void } = {}) {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null)
  const [actionsFor, setActionsFor] = useState<{ id: string; name: string; important: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeSessionId)
  const pending = useChatStore((state) => state.pendingSessions)
  const error = useChatStore((state) => state.sessionError)
  const load = useChatStore((state) => state.loadSessions)
  const select = useChatStore((state) => state.selectSession)
  const createSession = useChatStore((state) => state.createSession)
  const rename = useChatStore((state) => state.renameSession)
  const archive = useChatStore((state) => state.archiveSession)
  const remove = useChatStore((state) => state.deleteSession)
  const toggleImportant = useChatStore((state) => state.toggleImportant)
  const searchResults = useChatStore((state) => state.searchResults)
  const search = useChatStore((state) => state.searchSessions)
  const activity = useChatStore((state) => state.sessionActivity)
  const queuedSends = useChatStore((state) => state.queuedSends)

  useEffect(() => { if (sessions.status === 'idle') void load() }, [load, sessions.status])
  useEffect(() => {
    const timer = setTimeout(() => { void search(query) }, 250)
    return () => clearTimeout(timer)
  }, [query, search])

  const setPaletteOpen = usePaletteStore((state) => state.setOpen)

  return (
    <section className="next-chat-sessions" aria-label="Conversations">
      <SectionHeader
        title="Conversations"
        actions={<Button variant="primary" disabled={Boolean(pending.new)} onClick={() => void createSession()}><Icon name="plus" size={14} /> New conversation</Button>}
      />
      <label className="next-chat-search">
        <span className="sr-only">Search conversations</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations…" />
        <button type="button" className="oc-kbd" title="Search everything (⌘K)" aria-label="Search everything (⌘K)" onClick={() => setPaletteOpen(true)}>⌘K</button>
      </label>
      {error && <p className="next-error-detail" role="alert">{error}</p>}
      <RemoteView
        remote={sessions}
        onRetry={() => void load()}
        empty={<EmptyState title="No conversations yet" hint="Create a chat to get started." />}
        isEmpty={(records) => records.every((record) => record.archived)}
      >
        {(records) => {
          const visible = [...records]
          .filter((record) => !record.archived)
          .filter((record) => !query.trim() || record.name.toLowerCase().includes(query.trim().toLowerCase()))
          .sort((a, b) => Number(b.important) - Number(a.important) || b.updated - a.updated)
          const shown = new Set(visible.map((record) => record.id))
          return <>{visible.map((record) => {
            const pendingLabel = pending[record.id]
            return (
              <ListRow
                key={record.id}
                title={<>{activity[record.id] === 'working' && <span className="next-conv-working" title="Working" aria-label="Working">● </span>}{activity[record.id] === 'complete' && <span className="next-conv-complete" title="Reply finished" aria-label="Reply finished">● </span>}{!activity[record.id] && queuedSends[record.id]?.length && <span className="next-conv-queued" title="Message queued" aria-label="Message queued">● </span>}{record.important && <span aria-label="Favorite">★ </span>}{record.name || 'New chat'}</>}
                meta={pendingLabel || <span className="mono">{record.model}{record.speed && record.speed !== 'normal' ? ` · ${record.speed}` : ''}{queuedSends[record.id]?.length ? ` · ${queuedSends[record.id].length} queued` : ''}</span>}
                selected={record.id === activeId}
                onClick={() => void select(record.id).then(onSelected)}
                actions={<Button variant="ghost" disabled={Boolean(pendingLabel)} title="Conversation actions" aria-label="Conversation actions" onClick={() => setActionsFor({ id: record.id, name: record.name, important: record.important })}><Icon name="dots" size={14} /></Button>}
              />
            )
          })}{query.trim().length >= 2 && <RemoteView remote={searchResults}>{(hits) => {
            const semantic = hits.filter((hit, index) => !shown.has(hit.session_id) && hits.findIndex((other) => other.session_id === hit.session_id) === index)
            return semantic.length ? <section aria-label="Message matches"><p className="sect-label">Messages</p>{semantic.map((hit) => <ListRow key={hit.session_id} title={hit.session_name || 'Conversation'} meta={hit.content_snippet} onClick={() => void select(hit.session_id).then(onSelected)} />)}</section> : null
          }}</RemoteView>}</>
        }}
      </RemoteView>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title="Rename conversation">
        <form onSubmit={(event) => {
          event.preventDefault()
          if (!editing?.name.trim()) return
          void rename(editing.id, editing.name.trim()).then((ok) => { if (ok) setEditing(null) })
        }}>
          <label>
            Name
            <input
              autoFocus
              value={editing?.name ?? ''}
              onChange={(event) => setEditing((current) => current ? { ...current, name: event.target.value } : null)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={!editing?.name.trim()}>Save</Button>
        </form>
      </Modal>
      <Modal open={actionsFor !== null} onClose={() => setActionsFor(null)} title={actionsFor?.name || 'Conversation actions'}>
        <div className="next-conversation-actions">
          <Button variant="ghost" onClick={() => { if (actionsFor) void toggleImportant(actionsFor.id, !actionsFor.important); setActionsFor(null) }}>{actionsFor?.important ? 'Remove favorite' : 'Add favorite'}</Button>
          <Button variant="ghost" onClick={() => { if (actionsFor) setEditing({ id: actionsFor.id, name: actionsFor.name }); setActionsFor(null) }}>Rename</Button>
          <Button variant="ghost" onClick={() => { if (actionsFor) void archive(actionsFor.id); setActionsFor(null) }}>Archive</Button>
          <Button variant="danger" onClick={() => { if (actionsFor) setDeleting({ id: actionsFor.id, name: actionsFor.name }); setActionsFor(null) }}>Delete</Button>
        </div>
      </Modal>
      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Delete conversation">
        <p>Delete “{deleting?.name || 'New chat'}” permanently? This cannot be undone.</p>
        <div className="next-modal-actions">
          <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { if (deleting) void remove(deleting.id).then((ok) => { if (ok) setDeleting(null) }) }}>Delete</Button>
        </div>
      </Modal>
    </section>
  )
}
