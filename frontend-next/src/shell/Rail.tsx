import { TABS } from '../tabs/registry'
import { useAppStore } from '../store/app'
import { useWorkspaceStore } from './workspace/store'
import { useTerminalPanel } from './terminal/store'

export function Rail({ tab, navigate }: { tab: string; navigate: (tab: string) => void }) {
  const config = useAppStore((s) => s.config)
  // Honesty rule: the agent's name comes from /api/config — never hardcoded.
  const agentName = config.status === 'ready' ? config.data.agent_name : '…'
  const showWorkspace = useWorkspaceStore((state) => state.show)
  const showTerminal = useTerminalPanel((state) => state.show)
  return (
    <nav className="next-rail" aria-label="Primary">
      <div className="next-rail-brand" title={agentName}>{agentName}</div>
      <ul className="next-rail-list">
        {TABS.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={`next-rail-item${t.id === tab ? ' is-active' : ''}`}
              aria-current={t.id === tab ? 'page' : undefined}
              onClick={() => navigate(t.id)}
            >
              <span className="next-rail-icon" aria-hidden="true">{t.icon}</span>
              <span className="next-rail-label">{t.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="next-rail-mobile-tools"><button type="button" className="next-rail-mobile-tool" onClick={() => showTerminal()}><span>⌘</span><span>Terminal</span></button><button type="button" className="next-rail-mobile-tool" onClick={showWorkspace}><span>📁</span><span>Workspace</span></button></div>
      <div className="next-rail-foot">
        <button type="button" className="next-rail-tool" onClick={() => showTerminal()}>⌘ Terminal</button>
        <button type="button" className="next-rail-tool" onClick={showWorkspace}>📁 Workspace</button>
        <a className="next-rail-classic" href="/" title="Open the classic app">classic app ↗</a>
      </div>
    </nav>
  )
}
