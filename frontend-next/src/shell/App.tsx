import { useEffect } from 'react'
import { useHashRoute } from './router'
import { Rail } from './Rail'
import { ErrorBoundary } from './ErrorBoundary'
import { ToastHost } from '../kit'
import { tabById } from '../tabs/registry'
import { useAppStore } from '../store/app'
import { useChatStore } from '../tabs/chat/store'
import { WorkspacePanel } from './workspace/WorkspacePanel'
import { TerminalPanel } from './terminal/TerminalPanel'

export function App() {
  const { tab, navigate } = useHashRoute()
  const loadConfig = useAppStore((s) => s.loadConfig)
  const loadCapabilities = useAppStore((s) => s.loadCapabilities)
  const startActivityWatch = useChatStore((s) => s.startActivityWatch)
  const stopActivityWatch = useChatStore((s) => s.stopActivityWatch)

  useEffect(() => {
    void loadConfig()
    void loadCapabilities()
  }, [loadConfig, loadCapabilities])

  useEffect(() => {
    startActivityWatch()
    return stopActivityWatch
  }, [startActivityWatch, stopActivityWatch])

  const { Component } = tabById(tab)

  return (
    <div className="next-shell">
      <Rail tab={tab} navigate={navigate} />
      <main className="next-main">
        <ErrorBoundary resetKey={tab}>
          <Component />
        </ErrorBoundary>
      </main>
      <ToastHost />
      <WorkspacePanel />
      <TerminalPanel />
    </div>
  )
}
