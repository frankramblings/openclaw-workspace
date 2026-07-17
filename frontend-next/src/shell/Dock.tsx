import { useEffect, useState } from 'react'
import { TerminalInstance } from './terminal/TerminalInstance'
import { useChatStore } from '../tabs/chat/store'
import { useWorkspaceStore, type WorkspaceNode } from './workspace/store'

type DockTab = 'terminal' | 'files' | 'problems'

function FileNode({ node, depth, onOpen }: { node: WorkspaceNode; depth: number; onOpen: (path: string) => void }) {
  const [expanded, setExpanded] = useState(depth === 0)
  const isDir = node.type === 'dir'
  const selected = useWorkspaceStore((s) => s.selectedPath)
  const isSelected = selected === node.path

  if (isDir) {
    return (
      <div className="next-dock-files-dir">
        <button
          type="button"
          className={`next-dock-files-row${isSelected ? ' is-selected' : ''}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="next-dock-files-chevron">{expanded ? '▾' : '▸'}</span>
          <span className="next-dock-files-icon">📁</span>
          <span className="next-dock-files-name">{node.name}</span>
        </button>
        {expanded && node.children?.map((child) => (
          <FileNode key={child.path} node={child} depth={depth + 1} onOpen={onOpen} />
        ))}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={`next-dock-files-row${isSelected ? ' is-selected' : ''}`}
      style={{ paddingLeft: `${8 + depth * 14 + 16}px` }}
      onClick={() => onOpen(node.path)}
    >
      <span className="next-dock-files-icon">📄</span>
      <span className="next-dock-files-name">{node.name}</span>
      {node.size != null && <span className="next-dock-files-size">{node.size < 1024 ? `${node.size}B` : node.size < 1048576 ? `${(node.size / 1024).toFixed(0)}K` : `${(node.size / 1048576).toFixed(1)}M`}</span>}
    </button>
  )
}

function DockFiles() {
  const tree = useWorkspaceStore((s) => s.tree)
  const load = useWorkspaceStore((s) => s.load)
  const openPath = useWorkspaceStore((s) => s.openPath)
  const rootKey = useWorkspaceStore((s) => s.rootKey)

  useEffect(() => {
    if (tree.status === 'idle') void load()
  }, [load, tree.status])

  if (tree.status === 'idle' || tree.status === 'loading') {
    return <p className="next-dock-placeholder">Loading files…</p>
  }
  if (tree.status === 'error') {
    return <p className="next-dock-placeholder">Failed to load workspace tree.</p>
  }

  const nodes = tree.data.tree
  if (!nodes.length) {
    return <p className="next-dock-placeholder">Workspace is empty.</p>
  }

  return (
    <div className="next-dock-files">
      <div className="next-dock-files-root-label">{tree.data.root_key}</div>
      {nodes.map((node) => (
        <FileNode key={node.path} node={node} depth={0} onOpen={(path) => void openPath(path, rootKey)} />
      ))}
    </div>
  )
}

export function Dock() {
  const [open, setOpen] = useState(() => localStorage.getItem('next:dock-open') !== '0')
  const [activeTab, setActiveTab] = useState<DockTab>('terminal')
  const [chosenKey, setChosenKey] = useState<string | null>(null)
  const sessions = useChatStore((s) => s.sessions)
  const activeId = useChatStore((s) => s.activeSessionId)
  const loadSessions = useChatStore((s) => s.loadSessions)

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
          {activeTab === 'files' && <DockFiles />}
          {activeTab === 'problems' && <p className="next-dock-placeholder">Problems — nothing reported.</p>}
        </div>
      )}
    </section>
  )
}
