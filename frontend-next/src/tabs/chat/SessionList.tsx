import { useEffect, useState } from 'react'
import { Button, Chip, EmptyState, ListRow, Modal, RemoteView, SectionHeader } from '../../kit'
import { useChatStore } from './store'

export function SessionList() {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeSessionId)
  const pending = useChatStore((state) => state.pendingSessions)
  const error = useChatStore((state) => state.sessionError)
  const load = useChatStore((state) => state.loadSessions)
  const select = useChatStore((state) => state.selectSession)
  const createSession = useChatStore((state) => state.createSession)
  const rename = useChatStore((state) => state.renameSession)
  const archive = useChatStore((state) => state.archiveSession)
  const toggleImportant = useChatStore((state) => state.toggleImportant)

  useEffect(() => { if (sessions.status === 'idle') void load() }, [load, sessions.status])

  return (
    <section className="next-chat-sessions" aria-label="Conversations">
      <SectionHeader
        title="Conversations"
        actions={<Button variant="primary" disabled={Boolean(pending.new)} onClick={() => void createSession()}>New chat</Button>}
      />
      {error && <p className="next-error-detail" role="alert">{error}</p>}
      <RemoteView
        remote={sessions}
        onRetry={() => void load()}
        empty={<EmptyState title="No conversations yet" hint="Create a chat to get started." />}
        isEmpty={(records) => records.every((record) => record.archived)}
      >
        {(records) => [...records]
          .filter((record) => !record.archived)
          .sort((a, b) => Number(b.important) - Number(a.important) || b.updated - a.updated)
          .map((record) => {
            const pendingLabel = pending[record.id]
            return (
              <ListRow
                key={record.id}
                title={<>{record.important && <span aria-label="Favorite">★ </span>}{record.name || 'New chat'}</>}
                meta={pendingLabel || <><Chip>{record.model}</Chip> · {record.speed}</>}
                selected={record.id === activeId}
                onClick={() => void select(record.id)}
                actions={<>
                  <Button
                    variant="ghost"
                    disabled={Boolean(pendingLabel)}
                    title={record.important ? 'Remove favorite' : 'Favorite'}
                    onClick={() => void toggleImportant(record.id, !record.important)}
                  >★</Button>
                  <Button
                    variant="ghost"
                    disabled={Boolean(pendingLabel)}
                    title="Rename"
                    onClick={() => setEditing({ id: record.id, name: record.name })}
                  >Rename</Button>
                  <Button variant="ghost" disabled={Boolean(pendingLabel)} onClick={() => void archive(record.id)}>Archive</Button>
                </>}
              />
            )
          })}
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
    </section>
  )
}
