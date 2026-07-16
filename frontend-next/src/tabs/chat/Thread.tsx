import { Button, EmptyState, RemoteView } from '../../kit'
import { Message } from './Message'
import { useChatStore } from './store'

export function Thread() {
  const history = useChatStore((state) => state.history)
  const live = useChatStore((state) => state.liveTurn)
  const activeId = useChatStore((state) => state.activeSessionId)
  const hasMore = useChatStore((state) => state.hasMore)
  const loadOlder = useChatStore((state) => state.loadOlder)
  const select = useChatStore((state) => state.selectSession)
  const branchPrefix = useChatStore((state) => state.branchPrefix)

  if (!activeId) return <EmptyState title="Choose a conversation" hint="Select one from the sidebar or create a new chat." />

  const showLive = live && live.status !== 'done'
  return (
    <section className="chat-thread" aria-label="Conversation thread">
      {hasMore && <Button variant="ghost" onClick={() => void loadOlder()}>Load older messages</Button>}
      {branchPrefix && <section className="next-branch-prefix" aria-label="Branched conversation context"><p className="sect-label">Branched context</p>{branchPrefix.map((bubble) => <Message key={`branch-${bubble.id}`} bubble={bubble} />)}</section>}
      <RemoteView
        remote={history}
        onRetry={() => void select(activeId)}
        empty={showLive ? null : <EmptyState title="No messages yet" hint="The composer lands in the next task." />}
      >
        {(bubbles) => <>{bubbles.map((bubble) => <Message key={bubble.id} bubble={bubble} />)}</>}
      </RemoteView>
      {showLive && <div className="live-turn" aria-live="polite">
        {live.bubbles.map((bubble) => <Message key={`live-${bubble.id}`} bubble={bubble} />)}
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
    </section>
  )
}
