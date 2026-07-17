import { useEffect, type CSSProperties } from 'react'
import { useHashRoute } from './router'
import { TopBar } from './TopBar'
import { Dock } from './Dock'
import { ErrorBoundary } from './ErrorBoundary'
import { ToastHost } from '../kit'
import { tabById } from '../tabs/registry'
import { useAppStore } from '../store/app'
import { useChatStore } from '../tabs/chat/store'
import { SessionList } from '../tabs/chat/SessionList'
import { WorkspacePanel } from './workspace/WorkspacePanel'
import { TerminalPanel } from './terminal/TerminalPanel'
import { TaskPanel } from './tasks/TaskPanel'
import { PwaBanner } from './pwa/PwaBanner'
import { usePwaStore } from './pwa/store'
import { useShellLayout } from './layout/store'
import { CompanionResizeHandles } from './layout/CompanionResizeHandles'
import { useMutationToasts } from './useMutationToasts'

export function App() {
  const { tab, navigate } = useHashRoute()
  const loadConfig = useAppStore((s) => s.loadConfig)
  const loadCapabilities = useAppStore((s) => s.loadCapabilities)
  const startActivityWatch = useChatStore((s) => s.startActivityWatch)
  const stopActivityWatch = useChatStore((s) => s.stopActivityWatch)
  const initPwa = usePwaStore((s) => s.init)
  const layout = useShellLayout()
  useMutationToasts()

  useEffect(() => {
    void loadConfig()
    void loadCapabilities()
  }, [loadConfig, loadCapabilities])

  useEffect(() => {
    startActivityWatch()
    return stopActivityWatch
  }, [startActivityWatch, stopActivityWatch])

  useEffect(() => initPwa(), [initPwa])

  const { Component } = tabById(tab)

  return (
    <div className="next-shell" style={{ '--next-workspace-width': `${layout.workspaceWidth}px`, '--next-terminal-height': `${layout.terminalHeight}px`, '--next-task-width': `${layout.taskWidth}px` } as CSSProperties}>
      <TopBar tab={tab} navigate={navigate} />
      <div className={`next-shell-body${tab === 'chat' ? ' has-rail' : ''}`}>
        {tab === 'chat' && (
          <aside className="next-shell-rail">
            <SessionList />
          </aside>
        )}
        <div className="next-shell-stage">
          <main className="next-main">
            <ErrorBoundary resetKey={tab}>
              <Component />
            </ErrorBoundary>
          </main>
          <Dock />
        </div>
      </div>
      <ToastHost />
      <WorkspacePanel />
      <TerminalPanel />
      <TaskPanel />
      <CompanionResizeHandles />
      <PwaBanner />
    </div>
  )
}
