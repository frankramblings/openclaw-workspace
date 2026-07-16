import { useEffect } from 'react'
import { Button, EmptyState } from '../../kit'
import { useChatStore } from '../../tabs/chat/store'
import { useHistoryLayer } from '../useHistoryLayer'
import { TerminalInstance } from './TerminalInstance'
import { useTerminalPanel } from './store'

export function TerminalPanel() {
  const panel = useTerminalPanel()
  const sessions = useChatStore(state => state.sessions)
  const activeId = useChatStore(state => state.activeSessionId)
  const loadSessions = useChatStore(state => state.loadSessions)
  const close = useHistoryLayer(panel.open, panel.close)
  const records = sessions.status === 'ready' ? sessions.data.filter(session => !session.archived) : []
  const activeKey = records.find(session => session.id === activeId)?.sessionKey
  const key = panel.sessionKey || activeKey || records[0]?.sessionKey || null
  useEffect(() => { if (panel.open && sessions.status === 'idle') void loadSessions() }, [loadSessions, panel.open, sessions.status])
  useEffect(() => { if (panel.open && !panel.sessionKey && activeKey) panel.choose(activeKey) }, [activeKey, panel.open, panel.sessionKey, panel.choose])
  if (!panel.open) return null
  const visible = [...new Set([...panel.pinned, ...(key ? [key] : [])])]
  const names = new Map(records.map(record => [record.sessionKey, record.name || 'Conversation']))
  return <aside className="next-terminal-panel is-open" aria-label="Terminal"><header className="next-terminal-global-head"><strong>Terminals · {visible.length}</strong><select aria-label="Terminal conversation" value={key || ''} onChange={event => panel.choose(event.target.value)}>{records.map(session => <option key={session.id} value={session.sessionKey}>{session.name}</option>)}</select><Button variant="ghost" disabled={!key} onClick={() => { if (key) panel.togglePin(key) }}>{key && panel.pinned.includes(key) ? 'Unpin current' : 'Pin current'}</Button><Button variant="ghost" onClick={close}>Close</Button></header>{visible.length ? <div className="next-terminal-grid">{visible.map(sessionKey => <TerminalInstance key={sessionKey} sessionKey={sessionKey} name={names.get(sessionKey) || sessionKey} selected={sessionKey === key} pinned={panel.pinned.includes(sessionKey)} onSelect={() => panel.choose(sessionKey)} onUnpin={() => panel.togglePin(sessionKey)} />)}</div> : <EmptyState title="No conversation terminal" hint="Create or select a conversation first." />}</aside>
}
