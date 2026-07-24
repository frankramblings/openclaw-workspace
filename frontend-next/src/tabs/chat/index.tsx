import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
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
          <ConvDrawer onClose={() => setDrawerOpen(false)}>
            <SessionList onSelected={() => setDrawerOpen(false)} />
          </ConvDrawer>
        </>
      )}
    </div>
  )
}

/** Left drawer with swipe-to-close: the transform tracks the finger raw
 *  (no transition mid-drag — easing against live frames is the jank), then
 *  springs shut or back on release. */
function ConvDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const el = useRef<HTMLElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const dx = useRef(0)
  const down = (event: ReactPointerEvent) => { if (event.pointerType !== 'mouse') start.current = { x: event.clientX, y: event.clientY } }
  const move = (event: ReactPointerEvent) => {
    if (!start.current || !el.current) return
    const x = event.clientX - start.current.x
    const y = event.clientY - start.current.y
    if (Math.abs(x) > Math.abs(y) && x < -8) {
      event.currentTarget.setPointerCapture(event.pointerId)
      dx.current = x
      el.current.style.transition = 'none'
      el.current.style.transform = `translateX(${x}px)`
    }
  }
  const up = () => {
    if (!el.current) { start.current = null; return }
    el.current.style.transition = 'transform .18s ease'
    if (dx.current < -70) {
      el.current.style.transform = 'translateX(-105%)'
      setTimeout(onClose, 160)
    } else {
      el.current.style.transform = ''
    }
    start.current = null
    dx.current = 0
  }
  return (
    <aside ref={el} className="next-conv-drawer" aria-label="Conversations" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {children}
    </aside>
  )
}
