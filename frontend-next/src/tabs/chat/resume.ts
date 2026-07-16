import { parseFrame, type ChatEvent } from '../../api/events'
import { applyEvent, emptyTurn, type Turn } from './reducer'

export interface StoredEvent { id: string; data: string }
export interface TurnSnapshot {
  active: boolean
  turn_start_id: string | null
  events: StoredEvent[]
  last_event_id: string | null
  elapsed_ms: number | null
  turn_id?: number | null
  last_turn?: { turn_id: number; status: 'interrupted' }
}

export type ReconcileAction = 'attach' | 'finalize-interrupted' | 'finalize-stale' | 'none'

export function reconcileDecision(input: {
  active: boolean
  lastTurnStatus: 'interrupted' | null
  hasLocalLive: boolean
  localSessionMatches: boolean
  localFresh?: boolean
}): ReconcileAction {
  if (input.active) {
    if (input.hasLocalLive && input.localSessionMatches && input.localFresh) return 'none'
    return 'attach'
  }
  if (!input.hasLocalLive || !input.localSessionMatches) return 'none'
  return input.lastTurnStatus === 'interrupted' ? 'finalize-interrupted' : 'finalize-stale'
}

export function eventsFromStored(event: StoredEvent): ChatEvent[] {
  return event.data.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('data:')) return []
    const parsed = parseFrame(line.slice(5))
    return parsed ? [parsed] : []
  })
}

export function hydrateTurn(events: StoredEvent[]): Turn {
  return events.flatMap(eventsFromStored).reduce(applyEvent, emptyTurn())
}
