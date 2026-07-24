import { useEffect, useState } from 'react'
import { Card } from '../../kit'
import { Composer } from './Composer'
import { ChatHeader } from './ChatHeader'
import { SessionList } from './SessionList'
import { Thread } from './Thread'
import { useChatStore } from './store'

export function ChatTab() {
  // Phone conversations drawer — the shell rail is desktop-only, so mobile
  // needs its own way into the session list (classic's sidebar sheet).
  const [drawerOpen, setDrawerOpen] = useState(false)
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
      <ChatHeader onOpenConversations={() => setDrawerOpen(true)} />
      <Thread />
      <Card title="Composer"><Composer /></Card>
      {drawerOpen && (
        <>
          <button type="button" className="next-sheet-scrim" aria-label="Close conversations" onClick={() => setDrawerOpen(false)} />
          <aside className="next-conv-drawer" aria-label="Conversations">
            <SessionList onSelected={() => setDrawerOpen(false)} />
          </aside>
        </>
      )}
    </div>
  )
}
