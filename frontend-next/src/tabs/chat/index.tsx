import { useEffect, useState, type CSSProperties } from 'react'
import { Button, Card } from '../../kit'
import { Composer } from './Composer'
import { ChatHeader } from './ChatHeader'
import { ModelPicker } from './ModelPicker'
import { SessionList } from './SessionList'
import { Thread } from './Thread'
import { useChatStore } from './store'
import { ResizeHandle } from '../../shell/layout/ResizeHandle'
import { useShellLayout } from '../../shell/layout/store'

export function ChatTab() {
  const [mobilePanel, setMobilePanel] = useState<'sessions' | 'models' | null>(null)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeSessionId)
  const loadSessions = useChatStore((state) => state.loadSessions)
  const loadModels = useChatStore((state) => state.loadModels)
  const loadDefault = useChatStore((state) => state.loadDefaultChat)
  const select = useChatStore((state) => state.selectSession)
  const layout = useShellLayout()

  useEffect(() => {
    void loadSessions()
    void loadModels()
    void loadDefault()
  }, [loadDefault, loadModels, loadSessions])

  useEffect(() => {
    if (sessions.status !== 'ready') return
    const requested = sessionStorage.getItem('next:chat')
    if (requested) {
      sessionStorage.removeItem('next:chat')
      if (sessions.data.some((record) => record.id === requested && !record.archived)) void select(requested)
      return
    }
    if (activeId) return
    const first = sessions.data.find((record) => !record.archived)
    if (first) void select(first.id)
  }, [activeId, select, sessions])

  return (
    <div className="next-chat-layout" style={{ '--next-chat-sessions': `${layout.chatSessionsWidth}px`, '--next-chat-models': `${layout.chatModelsWidth}px` } as CSSProperties}>
      <div className="next-chat-mobilebar">
        <Button variant="ghost" onClick={() => setMobilePanel('sessions')}>Conversations</Button>
        <Button variant="ghost" onClick={() => setMobilePanel('models')}>Model</Button>
      </div>
      {mobilePanel && <button className="next-chat-scrim" type="button" aria-label="Close panel" onClick={() => setMobilePanel(null)} />}
      <aside className={`next-chat-sidebar${mobilePanel === 'sessions' ? ' is-open' : ''}`}><SessionList onSelected={() => setMobilePanel(null)} /><ResizeHandle axis="x" value={layout.chatSessionsWidth} onChange={layout.setChatSessionsWidth} label="Resize conversations" /></aside>
      <main className="next-chat-main">
        <ChatHeader />
        <Thread />
        <Card title="Composer"><Composer /></Card>
      </main>
      <aside className={`next-chat-models${mobilePanel === 'models' ? ' is-open' : ''}`}><ResizeHandle axis="x" invert value={layout.chatModelsWidth} onChange={layout.setChatModelsWidth} label="Resize model panel" /><ModelPicker /></aside>
    </div>
  )
}
