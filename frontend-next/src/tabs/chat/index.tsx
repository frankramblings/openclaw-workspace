import { useEffect, useState } from 'react'
import { Button, Card } from '../../kit'
import { Composer } from './Composer'
import { ChatHeader } from './ChatHeader'
import { ModelPicker } from './ModelPicker'
import { SessionList } from './SessionList'
import { Thread } from './Thread'
import { useChatStore } from './store'

export function ChatTab() {
  const [mobilePanel, setMobilePanel] = useState<'sessions' | 'models' | null>(null)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeSessionId)
  const loadSessions = useChatStore((state) => state.loadSessions)
  const loadModels = useChatStore((state) => state.loadModels)
  const loadDefault = useChatStore((state) => state.loadDefaultChat)
  const select = useChatStore((state) => state.selectSession)

  useEffect(() => {
    void loadSessions()
    void loadModels()
    void loadDefault()
  }, [loadDefault, loadModels, loadSessions])

  useEffect(() => {
    if (activeId || sessions.status !== 'ready') return
    const first = sessions.data.find((record) => !record.archived)
    if (first) void select(first.id)
  }, [activeId, select, sessions])

  return (
    <div className="next-chat-layout">
      <div className="next-chat-mobilebar">
        <Button variant="ghost" onClick={() => setMobilePanel('sessions')}>Conversations</Button>
        <Button variant="ghost" onClick={() => setMobilePanel('models')}>Model</Button>
      </div>
      {mobilePanel && <button className="next-chat-scrim" type="button" aria-label="Close panel" onClick={() => setMobilePanel(null)} />}
      <aside className={`next-chat-sidebar${mobilePanel === 'sessions' ? ' is-open' : ''}`}><SessionList onSelected={() => setMobilePanel(null)} /></aside>
      <main className="next-chat-main">
        <ChatHeader />
        <Thread />
        <Card title="Composer"><Composer /></Card>
      </main>
      <aside className={`next-chat-models${mobilePanel === 'models' ? ' is-open' : ''}`}><ModelPicker /></aside>
    </div>
  )
}
