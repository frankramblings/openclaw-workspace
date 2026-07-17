import { useEffect, useState } from 'react'
import { TerminalInstance } from './terminal/TerminalInstance'
import { useChatStore } from '../tabs/chat/store'

type DockTab = 'terminal' | 'files' | 'problems'

export function Dock() {
  const [open, setOpen] = useState(() => localStorage.getItem('next:dock-open') !== '0')
  const [activeTab, setActiveTab] = useState<DockTab>('terminal')
  // The dock owns its own terminal selection. It defaults to the active
  // conversation but is not the floating panel's — the two are independent.
  const [chosenKey, setChosenKey] = useState<string | null>(null)
  const sessions = useChatStore((s) => s.sessions)
  const activeId = useChatStore((s) => s.activeSessionId)
  const loadSessions = useChatStore((s) => s.loadSessions)

  // Read the stale value too, not just 'ready'. A refresh (creating a chat
  // reloads /api/sessions) flips this to 'loading'; blanking the list there
  // would drop `key` to null, unmount the terminal, and dispose xterm — whose
  // Viewport constructor queues an un-disposable setTimeout(syncScrollArea)
  // that then reads dimensions off the torn-down renderer and throws.
  const loaded = sessions.status === 'ready' ? sessions.data
    : sessions.status === 'loading' || sessions.status === 'error' ? sessions.stale
    : undefined
  const records = (loaded ?? []).filter((s) => !s.archived)
  const activeKey = records.find((s) => s.id === activeId)?.sessionKey ?? records[0]?.sessionKey ?? null
  const key = (chosenKey && records.some((s) => s.sessionKey === chosenKey) ? chosenKey : activeKey)

  const showTerminal = open && activeTab === 'terminal'
  useEffect(() => {
    if (showTerminal && sessions.status === 'idle') void loadSessions()
  }, [loadSessions, showTerminal, sessions.status])

  const toggle = (next: boolean) => {
    localStorage.setItem('next:dock-open', next ? '1' : '0')
    setOpen(next)
  }
  const pick = (next: DockTab) => { setActiveTab(next); toggle(true) }

  return (
    <section className={`next-dock${open ? ' is-open' : ''}`} aria-label="Bottom dock">
      <div className="next-dock-head">
        <button
          type="button"
          className="next-dock-collapse"
          aria-label={open ? 'Collapse dock' : 'Expand dock'}
          aria-expanded={open}
          onClick={() => toggle(!open)}
        >
          {open ? '▾' : '▸'}
        </button>
        <button type="button" className={`next-dock-tab${activeTab === 'terminal' ? ' is-active' : ''}`} onClick={() => pick('terminal')}>›_ Terminal</button>
        <button type="button" className={`next-dock-tab${activeTab === 'files' ? ' is-active' : ''}`} onClick={() => pick('files')}>📁 Files</button>
        <button type="button" className={`next-dock-tab${activeTab === 'problems' ? ' is-active' : ''}`} onClick={() => pick('problems')}>⚠ Problems</button>
        <span className="next-dock-spacer" />
        {key && (
          <select
            className="next-dock-session"
            aria-label="Dock terminal conversation"
            value={key}
            onChange={(e) => setChosenKey(e.target.value)}
          >
            {records.map((s) => <option key={s.id} value={s.sessionKey}>{s.name || 'Conversation'}</option>)}
          </select>
        )}
      </div>

      {open && (
        <div className="next-dock-body">
          {activeTab === 'terminal' && (key
            ? <TerminalInstance key={key} sessionKey={key} name={records.find((s) => s.sessionKey === key)?.name || 'Conversation'} selected pinned={false} onSelect={() => {}} onUnpin={() => {}} />
            : <p className="next-dock-placeholder">No active conversation. Start a chat to open a terminal.</p>)}
          {activeTab === 'files' && <p className="next-dock-placeholder">Files pane — not built yet. Use 📁 Workspace.</p>}
          {activeTab === 'problems' && <p className="next-dock-placeholder">Problems — nothing reported.</p>}
        </div>
      )}
    </section>
  )
}
