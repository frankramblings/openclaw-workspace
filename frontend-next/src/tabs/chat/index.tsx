import { useEffect } from 'react'
import { Card } from '../../kit'
import { Composer } from './Composer'
import { ModelPicker } from './ModelPicker'
import { SessionList } from './SessionList'
import { Thread } from './Thread'
import { useChatStore } from './store'

export function ChatTab() {
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
      <aside className="next-chat-sidebar"><SessionList /></aside>
      <main className="next-chat-main">
        <Thread />
        <Card title="Composer"><Composer /></Card>
      </main>
      <aside className="next-chat-models"><ModelPicker /></aside>
    </div>
  )
}
