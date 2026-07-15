// Pure context builders for composer ghost suggestions. Ported 1:1 from
// frontend-overrides/js/redesign/live/suggest-core.js (2026-07-15). DOM-free.

const MAX_CONTEXT = 4000

export interface SuggestGhost {
  text: string
  mode: 'followup' | 'midturn'
  sessionId: string
}

export interface ThreadMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface ActivityLike {
  steps?: { label?: string; file?: string }[]
}

// attachTurn REPLAYS a still-in-flight turn (iOS resume, dropped stream) via
// beginTurn, whose blanket "new turn invalidates the ghost" clear would eat
// the mid-turn ghost that this same turn generated. Only that ghost is still
// valid across the replay; a followup ghost with a turn in flight is stale.
export function suggestSurvivesReattach(suggest: SuggestGhost | null | undefined, sessionId: string): boolean {
  return !!(suggest && suggest.mode === 'midturn' && suggest.sessionId === sessionId)
}

// {role, text} thread → "User: …\n\nAssistant: …", tail-capped at 4000 chars.
// `extra` (midturn activity summary) is appended last so it survives the cap.
// Walks the thread from the END and stops once the cap is covered.
export function buildSuggestContext(thread: ThreadMessage[] | null | undefined, extra = ''): string {
  const list = Array.isArray(thread) ? thread : []
  const lines: string[] = []
  let total = 0
  for (let i = list.length - 1; i >= 0 && total <= MAX_CONTEXT; i--) {
    const m = list[i]
    const text = String((m && m.text) || '').trim()
    if (!text) continue
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`
    lines.unshift(line)
    total += line.length + 2
  }
  let ctx = lines.join('\n\n')
  if (extra) ctx = ctx ? `${ctx}\n\n${extra}` : extra
  return ctx.length > MAX_CONTEXT ? ctx.slice(-MAX_CONTEXT) : ctx
}

// Live activity trail → a short "what the assistant is doing" block for the
// midturn prompt. Last 6 steps is plenty of signal for one suggestion.
export function activitySummary(activity: ActivityLike | null | undefined): string {
  const steps = activity && Array.isArray(activity.steps) ? activity.steps : []
  const labels = steps.slice(-6)
    .map((st) => [st.label, st.file].filter(Boolean).join(' ').trim())
    .filter(Boolean)
  if (!labels.length) return ''
  return `Assistant is still working. Recent activity:\n${labels.map((l) => `- ${l}`).join('\n')}`
}
