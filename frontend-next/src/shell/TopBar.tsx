import { TABS } from '../tabs/registry'
import { useAppStore } from '../store/app'
import { useWorkspaceStore } from './workspace/store'
import { useTerminalPanel } from './terminal/store'
import { useTaskPanel } from './tasks/store'
import { useChatStore } from '../tabs/chat/store'

/** Primary tabs shown as labeled pills; the rest as icon-only overflow. */
const PRIMARY_IDS = ['chat', 'inbox', 'email', 'calendar', 'notes', 'documents']

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

  const primary = TABS.filter((t) => PRIMARY_IDS.includes(t.id))
  const secondary = TABS.filter((t) => !PRIMARY_IDS.includes(t.id))

  return (
    <header className="next-topbar">
      <div className="next-topbar-lights" aria-hidden="true">
        <span className="next-topbar-light next-topbar-light-red" />
        <span className="next-topbar-light next-topbar-light-yellow" />
        <span className="next-topbar-light next-topbar-light-green" />
      </div>

      <div className="next-topbar-brand" title={agentName}><span>{agentName}</span></div>

      <nav className="next-topbar-nav" aria-label="Primary">
        <div className="next-topbar-tabs">
          {primary.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`next-topbar-tab${t.id === tab ? ' is-active' : ''}`}
              aria-current={t.id === tab ? 'page' : undefined}
              onClick={() => navigate(t.id)}
            >
              <span className="next-topbar-tab-icon" aria-hidden="true">{t.icon}</span>
              <span className="next-topbar-tab-label">{t.label}</span>
            </button>
          ))}
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
              onClick={() => navigate(t.id)}
            >
              <span aria-hidden="true">{t.icon}</span>
            </button>
          ))}
        </div>
      </nav>

      <span className="next-topbar-spacer" />

      <span className={`next-topbar-status${working ? ' is-working' : ''}`}>
        <span className="next-topbar-dot" aria-hidden="true" />
        <span>{working ? 'Working' : 'Idle'}</span>
      </span>

      <button type="button" className="next-topbar-util" title="Terminal" aria-label="Terminal" onClick={() => showTerminal()}>⌘</button>
      <button type="button" className="next-topbar-util" title="Workspace" aria-label="Workspace" onClick={showWorkspace}>📁</button>
      <button type="button" className="next-topbar-util" title="Tasks" aria-label="Tasks" onClick={showTasks}>✓</button>
      <a className="next-topbar-classic" href="/" title="Open the classic app">classic ↗</a>
    </header>
  )
}
