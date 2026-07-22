import { useRef } from 'react'
import { Button, RemoteView } from '../../kit'
import { ChatWelcome } from './ChatWelcome'
import { Message } from './Message'
import { PendingMessage } from './PendingMessage'
import { useStickToBottom } from './useStickToBottom'
import { useChatStore } from './store'

export function Thread() {
  const threadRef = useRef<HTMLElement>(null)
  const history = useChatStore((state) => state.history)
  const live = useChatStore((state) => state.liveTurn)
  const activeId = useChatStore((state) => state.activeSessionId)
  const hasMore = useChatStore((state) => state.hasMore)
  const loadOlder = useChatStore((state) => state.loadOlder)
  const select = useChatStore((state) => state.selectSession)
  const branchPrefix = useChatStore((state) => state.branchPrefix)

  const { pinned, jumpToBottom } = useStickToBottom(threadRef)

  if (!activeId) return <ChatWelcome />

  const showLive = live && live.status !== 'done'
  // Pill is specifically "there's an active stream you're missing" (design
  // spec decision 5: "jump-to-bottom pill while unpinned during a stream")
  // — narrower than showLive, which also covers sending/stalled/error/
  // aborted turns that still need their status line rendered but aren't an
  // active stream to jump back into.
  const showPill = !pinned && live?.status === 'streaming'
  return (
    <section ref={threadRef} className="chat-thread" aria-label="Conversation thread">
      {hasMore && <Button variant="ghost" onClick={() => void loadOlder()}>Load older messages</Button>}
      {branchPrefix && <section className="next-branch-prefix" aria-label="Branched conversation context"><p className="sect-label">Branched context</p>{branchPrefix.map((bubble) => <Message key={`branch-${bubble.id}`} bubble={bubble} />)}</section>}
      <RemoteView
        remote={history}
        onRetry={() => void select(activeId)}
        empty={showLive ? null : <ChatWelcome />}
      >
        {(bubbles) => <>{bubbles.map((bubble) => <Message key={bubble.id} bubble={bubble} />)}</>}
      </RemoteView>
      <PendingMessage />
      {showLive && <div className="live-turn" aria-live="polite">
        {live.bubbles.map((bubble) => <Message key={`live-${bubble.id}`} bubble={bubble} streaming={live.status === 'streaming'} />)}
        <p className="live-turn-status">
          {live.status === 'stalled'
            ? `Waiting for the gateway · ${live.stallSeconds ?? 0}s silent`
            : live.status === 'error'
              ? 'The stream disconnected before completion.'
              : live.status === 'aborted'
                ? 'Stopped'
                : 'Working…'}
          {live.modelFallback && ` · using ${live.modelFallback}`}
        </p>
      </div>}
      {showPill && <button className="jump-bottom-pill" onClick={jumpToBottom} title="Jump to latest message" aria-label="Jump to latest">↓</button>}
    </section>
  )
}
