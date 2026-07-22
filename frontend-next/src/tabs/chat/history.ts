import type { Bubble, ToolCard } from './reducer'
import type { HistoryItem } from './types'

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((block) => {
    if (typeof block === 'string') return block
    if (!block || typeof block !== 'object') return ''
    const record = block as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    return typeof record.content === 'string' ? record.content : ''
  }).filter(Boolean).join('\n')
}

function historyCards(metadata: Record<string, unknown>, messageIndex: number): ToolCard[] {
  const events = Array.isArray(metadata.tool_events) ? metadata.tool_events : []
  return events.flatMap((raw, toolIndex) => {
    if (!raw || typeof raw !== 'object') return []
    const event = raw as Record<string, unknown>
    const exitCode = event.exit_code === 1 ? 1 : 0
    return [{
      toolId: `history-${messageIndex}-tool-${toolIndex}`,
      tool: typeof event.tool === 'string' ? event.tool : 'tool',
      command: typeof event.command === 'string' ? event.command : undefined,
      output: typeof event.output === 'string' ? event.output : undefined,
      exitCode,
      state: exitCode === 0 ? 'done' as const : 'error' as const,
    }]
  })
}

function historyAttachments(raw: unknown): NonNullable<Bubble['attachments']> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    if (typeof record.id !== 'string') return []
    return [{
      id: record.id,
      name: typeof record.name === 'string' ? record.name : record.id,
      ...(typeof record.url === 'string' ? { url: record.url } : {}),
    }]
  })
}

/** Normalize the gateway transcript into the same declarative shape used by
 * live turns. History is complete, so every reconstructed tool is terminal. */
export function parseHistory(items: HistoryItem[]): Bubble[] {
  return items.map((item, index) => {
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {}
    const rounds = Array.isArray(metadata.round_texts)
      ? metadata.round_texts.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const role = item.role === 'user' ? 'user' : 'assistant'
    return {
      id: `history-${index}`,
      role,
      text: role === 'assistant' && rounds.length ? rounds.at(-1)! : textContent(item.content),
      thinking: '',
      cards: role === 'assistant' ? historyCards(metadata, index) : [],
      images: [],
      attachments: role === 'user' ? historyAttachments(item.attachments) : [],
      ...(typeof metadata.model === 'string' && metadata.model ? { model: metadata.model } : {}),
      ...(typeof metadata.timestamp === 'number' ? { ts: metadata.timestamp } : {}),
    }
  })
}
