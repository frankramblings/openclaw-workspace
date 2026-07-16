import { useEffect } from 'react'
import { Button, Card, EmptyState, ListRow, RemoteView, SectionHeader } from '../../kit'
import { actionLabel, ageLabelFor, groupBySource, primaryActions } from './logic'
import { useInboxStore } from './store'

export function InboxTab() {
  const store = useInboxStore()
  useEffect(() => { void store.load() }, [])
  return <main className="next-tab"><SectionHeader title="Inbox" actions={<><Button variant="ghost" onClick={() => void store.triage()}>Triage</Button><Button onClick={() => void store.load()}>Refresh</Button></>} />
    <RemoteView remote={store.feed} onRetry={store.load} empty={<EmptyState title="Inbox clear" hint="No items were returned by enabled sources." />} isEmpty={(feed) => feed.items.length === 0}>{(feed) => <>
      {Object.entries(feed.errors).map(([source, error]) => <p className="next-error" key={source}>{source}: {error}</p>)}
      {groupBySource(feed.items).map(([source, items]) => <Card key={source} title={`${source} · ${feed.sources[source] ?? items.length}`}>
        {items.map((item) => <ListRow key={`${source}:${item.id}`} title={item.title} meta={`${item.subtitle ?? ''} · ${ageLabelFor(item, feed.generatedAt)}`} selected={store.selected?.id === item.id} onClick={() => void store.select(item)} actions={<>
          {primaryActions(item).map((action) => <Button key={action} variant="ghost" disabled={store.pendingId === item.id} onClick={() => void store.act(item, action)}>{actionLabel(action)}</Button>)}
          <Button variant="ghost" disabled={store.pendingId === item.id} onClick={() => void store.act(item, 'dismiss')}>Dismiss</Button>
          <Button variant="ghost" onClick={() => void store.spinoff(item)}>Hand off</Button>
        </>} />)}
      </Card>)}
    </>}</RemoteView>
    {store.selected && <Card title={store.selected.title}><p>{store.selected.snippet || store.selected.subtitle || 'No preview supplied.'}</p><RemoteView remote={store.detail}>{(detail) => <pre>{JSON.stringify(detail, null, 2)}</pre>}</RemoteView></Card>}
    <RemoteView remote={store.history}>{(history) => history.entries.length ? <Card title="Recent actions">{history.entries.map((entry) => <ListRow key={entry.ts} title={`${actionLabel(entry.action)} · ${entry.title}`} meta={entry.source} actions={entry.undoable ? <Button variant="ghost" onClick={() => void store.undo(entry.ts)}>Undo</Button> : undefined} />)}</Card> : null}</RemoteView>
  </main>
}

