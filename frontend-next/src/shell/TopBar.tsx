import { Fragment, useState } from 'react'
import { TABS } from '../tabs/registry'
import { Icon } from '../kit/icons'
import { useAppStore } from '../store/app'
import { useWorkspaceStore } from './workspace/store'
import { useTerminalPanel } from './terminal/store'
import { useTaskPanel } from './tasks/store'
import { useChatStore } from '../tabs/chat/store'

/** Primary tabs shown as labeled pills; the rest as icon-only overflow. */
const PRIMARY_IDS = ['chat', 'inbox', 'email', 'calendar']

export function TopBar({ tab, navigate }: { tab: string; navigate: (tab: string) => void }) {
  const config = useAppStore((s) => s.config)
  // Honesty rule: the agent's name comes from /api/config — never hardcoded.
  const agentName = config.status === 'ready' ? config.data.agent_name : '…'
  const showWorkspace = useWorkspaceStore((s) => s.show)
  const showTerminal = useTerminalPanel((s) => s.show)
  const showTasks = useTaskPanel((s) => s.show)
  // Same rule for status: reflect the activity watch rather than assert "live".
  const activity = useChatStore((s) => s.sessionActivity)
  const working = Object.values(activity).some((state) => state === 'working')
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const createSession = useChatStore((s) => s.createSession)
  const creatingSession = useChatStore((s) => Boolean(s.pendingSessions.new))
  const activeModel = sessions.status === 'ready' && activeSessionId
    ? sessions.data.find((s) => s.id === activeSessionId)?.model ?? null
    : null
  // Phone "More" sheet: everything the compact bottom bar can't hold.
  const [moreOpen, setMoreOpen] = useState(false)

  const primary = TABS.filter((t) => PRIMARY_IDS.includes(t.id))
  const secondary = TABS.filter((t) => !PRIMARY_IDS.includes(t.id))

  const newChat = () => {
    setMoreOpen(false)
    navigate('chat')
    void createSession()
  }
  const go = (id: string) => {
    setMoreOpen(false)
    navigate(id)
  }

  return (
    <header className="next-topbar">
      <div className="next-topbar-brand" title={agentName}><span>{agentName}</span></div>

      <nav className="next-topbar-nav" aria-label="Primary">
        <div className="next-topbar-tabs">
          {primary.map((t, index) => (
            <Fragment key={t.id}>
              {/* Classic mobile bar order: Chat · Inbox · [+] · Email · More */}
              {index === 2 && (
                <button key="newchat" type="button" className="next-topbar-newchat" aria-label="New conversation" disabled={creatingSession} onClick={newChat}>
                  <Icon name="plus" size={20} />
                </button>
              )}
              <button
                type="button"
                className={`next-topbar-tab${t.id === tab ? ' is-active' : ''}${t.id === 'calendar' ? ' next-topbar-tab-deskonly' : ''}`}
                aria-current={t.id === tab ? 'page' : undefined}
                onClick={() => go(t.id)}
              >
                <span className="next-topbar-tab-icon" aria-hidden="true"><Icon name={t.icon} size={16} /></span>
                <span className="next-topbar-tab-label">{t.label}</span>
              </button>
            </Fragment>
          ))}
          <button type="button" className={`next-topbar-tab next-topbar-more${moreOpen ? ' is-active' : ''}`} aria-label="More" onClick={() => setMoreOpen((open) => !open)}>
            <span className="next-topbar-tab-icon" aria-hidden="true"><Icon name="dots" size={16} /></span>
            <span className="next-topbar-tab-label">More</span>
          </button>
        </div>

        <div className="next-topbar-overflow">
          {secondary.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`next-topbar-tab-sm${t.id === tab ? ' is-active' : ''}`}
              aria-current={t.id === tab ? 'page' : undefined}
              aria-label={t.label}
              title={t.label}
              onClick={() => go(t.id)}
            >
              <span aria-hidden="true"><Icon name={t.icon} size={16} /></span>
            </button>
          ))}
        </div>
      </nav>

      <span className="next-topbar-spacer" />

      {activeModel && (
        <button type="button" className="next-topbar-model">
          <span className="next-topbar-model-dot">●</span>
          {activeModel}
        </button>
      )}
      <div className="next-topbar-avatar">F</div>

      <span className={`next-topbar-status${working ? ' is-working' : ''}`}>
        <span className="next-topbar-dot" aria-hidden="true" />
        <span>{working ? 'Working' : 'Idle'}</span>
      </span>

      <button type="button" className="next-topbar-util" title="Terminal" aria-label="Terminal" onClick={() => showTerminal()}><Icon name="terminal" size={15} /></button>
      <button type="button" className="next-topbar-util" title="Workspace" aria-label="Workspace" onClick={showWorkspace}><Icon name="folder" size={15} /></button>
      <button type="button" className="next-topbar-util" title="Tasks" aria-label="Tasks" onClick={showTasks}><Icon name="check" size={15} /></button>
      <a className="next-topbar-classic" href="/" title="Open the classic app">classic ↗</a>

      {moreOpen && (
        <>
          <button type="button" className="next-sheet-scrim" aria-label="Close" onClick={() => setMoreOpen(false)} />
          <div className="next-more-sheet" role="menu" aria-label="More">
            <div className="next-more-grid">
              {secondary.concat(TABS.filter((t) => t.id === 'calendar')).map((t) => (
                <button key={t.id} type="button" className={`next-more-item${t.id === tab ? ' is-active' : ''}`} onClick={() => go(t.id)}>
                  <Icon name={t.icon} size={18} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            <div className="next-more-row-group">
              <button type="button" className="next-more-row" onClick={() => { setMoreOpen(false); showTerminal() }}><Icon name="terminal" size={15} /> Terminal</button>
              <button type="button" className="next-more-row" onClick={() => { setMoreOpen(false); showWorkspace() }}><Icon name="folder" size={15} /> Files</button>
              <button type="button" className="next-more-row" onClick={() => { setMoreOpen(false); showTasks() }}><Icon name="check" size={15} /> Tasks</button>
              <a className="next-more-row" href="/">classic ↗</a>
            </div>
          </div>
        </>
      )}
    </header>
  )
}
