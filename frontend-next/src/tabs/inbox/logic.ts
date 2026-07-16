import type { InboxItem } from './types'

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return null
  if (/^\d+(\.\d+)?$/.test(value.trim())) return timestamp(Number(value))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function itemOriginMs(item: InboxItem): number | null {
  for (const key of ['receivedAt', 'date', 'start']) {
    const parsed = timestamp(item.meta[key])
    if (parsed !== null) return parsed
  }
  return item.source === 'entities' ? null : timestamp(item.ts)
}

export function ageLabelFor(item: InboxItem, now = Date.now()): string {
  const origin = itemOriginMs(item)
  if (origin === null) return '—'
  const future = origin > now
  const minutes = Math.floor(Math.abs(now - origin) / 60_000)
  if (minutes < 1) return 'now'
  let label: string
  if (minutes < 60) label = `${minutes}m`
  else if (minutes < 1_440) label = `${Math.round(minutes / 60)}h`
  else if (minutes < 10_080) label = `${Math.round(minutes / 1_440)}d`
  else {
    const date = new Date(origin)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) })
  }
  return future ? `in ${label}` : label
}

export function primaryActions(item: InboxItem): string[] {
  if (item.source === 'calendar' || item.actions.includes('rsvp')) return ['rsvp:accepted', 'rsvp:tentative', 'rsvp:declined']
  const preferred = ['add_asana', 'archive', 'mark_read', 'complete', 'reviewed', 'delete']
  return preferred.filter((action) => item.actions.includes(action)).slice(0, 2)
}

export function actionLabel(action: string): string {
  const labels: Record<string, string> = { add_asana: 'Add to Asana', mark_read: 'Mark read', 'rsvp:accepted': 'Yes', 'rsvp:tentative': 'Maybe', 'rsvp:declined': 'No' }
  return labels[action] ?? action.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
}

export function groupBySource(items: InboxItem[]): Array<[string, InboxItem[]]> {
  const groups = new Map<string, InboxItem[]>()
  for (const item of items) groups.set(item.source, [...(groups.get(item.source) ?? []), item])
  return [...groups.entries()]
}

