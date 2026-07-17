import { useEffect } from 'react'
import { Card } from '../../kit'
import { Composer } from './Composer'
import { ChatHeader } from './ChatHeader'
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
    <div className="next-chat-main">
      <ChatHeader />
      <Thread />
      <Card title="Composer"><Composer /></Card>
    </div>
  )
}
