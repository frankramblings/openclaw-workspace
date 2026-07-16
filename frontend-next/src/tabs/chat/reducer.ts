import type { ChatEvent } from '../../api/events'

export interface ToolCard {
  toolId: string
  tool: string
  command?: string
  input?: unknown
  output?: string
  exitCode?: 0 | 1
  state: 'running' | 'done' | 'error'
}

export interface Bubble {
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking: string
  cards: ToolCard[]
  images: { url: string; prompt?: string }[]
}

export interface Turn {
  turnId?: number
  status: 'sending' | 'streaming' | 'stalled' | 'done' | 'error' | 'aborted'
  bubbles: Bubble[]
  stallSeconds?: number
  modelFallback?: string
}

export function emptyTurn(): Turn {
  return { status: 'sending', bubbles: [] }
}

function assistantId(turn: Turn): string {
  const count = turn.bubbles.filter((bubble) => bubble.role === 'assistant').length
  return `assistant-${count + 1}`
}

function blankAssistant(turn: Turn): Bubble {
  return {
    id: assistantId(turn),
    role: 'assistant',
    text: '',
    thinking: '',
    cards: [],
    images: [],
  }
}

function withActiveAssistant(turn: Turn, update: (bubble: Bubble) => Bubble): Turn {
  const last = turn.bubbles.at(-1)
  if (!last || last.role !== 'assistant') {
    return { ...turn, bubbles: [...turn.bubbles, update(blankAssistant(turn))] }
  }
  return {
    ...turn,
    bubbles: [...turn.bubbles.slice(0, -1), update(last)],
  }
}

function clearStall(turn: Turn): Turn {
  if (turn.status !== 'stalled' && turn.stallSeconds === undefined) return turn
  const { stallSeconds: _stallSeconds, ...rest } = turn
  return { ...rest, status: 'streaming' }
}

function toolId(turn: Turn, eventId: string | null | undefined): string {
  if (eventId) return eventId
  const count = turn.bubbles.reduce((total, bubble) => total + bubble.cards.length, 0)
  return `tool-${count + 1}`
}

function appendTool(turn: Turn, event: Extract<ChatEvent, { type: 'tool_start' }>): Turn {
  const id = toolId(turn, event.tool_id)
  return withActiveAssistant(clearStall(turn), (bubble) => ({
    ...bubble,
    cards: [...bubble.cards, {
      toolId: id,
      tool: event.tool,
      command: event.command,
      input: event.input,
      state: 'running',
    }],
  }))
}

function finishTool(turn: Turn, event: Extract<ChatEvent, { type: 'tool_output' }>): Turn {
  const exactId = event.tool_id || undefined
  let found = false
  const bubbles = turn.bubbles.map((bubble) => ({
    ...bubble,
    cards: bubble.cards.map((card) => {
      const matches = exactId ? card.toolId === exactId : !found && card.state === 'running'
      if (!matches) return card
      found = true
      return {
        ...card,
        output: `${card.output ?? ''}${event.output}`,
        exitCode: event.exit_code,
        state: event.exit_code === 0 ? 'done' as const : 'error' as const,
      }
    }),
  }))

  let next: Turn = found ? { ...turn, bubbles } : withActiveAssistant(turn, (bubble) => ({
    ...bubble,
    cards: [...bubble.cards, {
      toolId: toolId(turn, exactId),
      tool: event.tool,
      output: event.output,
      exitCode: event.exit_code,
      state: event.exit_code === 0 ? 'done' : 'error',
    }],
  }))
  next = clearStall(next)

  // This is the backend's explicit rejection of a concurrent send. It is a
  // completed response, not a failed agent turn; the card itself carries the
  // backend's error state and explanation.
  if (event.tool === 'bridge' && event.tool_id === 'busy') {
    next = { ...next, status: 'done' }
  }
  return next
}

export function applyEvent(turn: Turn, event: ChatEvent): Turn {
  switch (event.type) {
    case 'turn_start':
      return { ...turn, turnId: event.turn_id, status: 'streaming' }
    case 'turn_end':
      return {
        ...turn,
        turnId: event.turn_id,
        status: event.status === 'ok' ? 'done' : event.status,
        stallSeconds: undefined,
      }
    case 'text':
      return withActiveAssistant(clearStall(turn), (bubble) => event.thinking
        ? { ...bubble, thinking: bubble.thinking + event.delta }
        : { ...bubble, text: bubble.text + event.delta })
    case 'image':
      return withActiveAssistant(clearStall(turn), (bubble) => ({
        ...bubble,
        images: [...bubble.images, { url: event.url, prompt: event.prompt }],
      }))
    case 'agent_step':
      return { ...clearStall(turn), bubbles: [...turn.bubbles, blankAssistant(turn)] }
    case 'reply_reset':
      return withActiveAssistant(turn, (bubble) => ({ ...bubble, text: '' }))
    case 'tool_start':
      return appendTool(turn, event)
    case 'tool_output':
      return finishTool(turn, event)
    case 'stall':
      return { ...turn, status: 'stalled', stallSeconds: event.silent_for }
    case 'stall_retry':
      return clearStall(turn)
    case 'model_fallback':
      if (event.data.phase === 'cleared') {
        const { modelFallback: _modelFallback, ...rest } = turn
        return rest
      }
      return {
        ...turn,
        modelFallback: event.data.new_model ?? event.data.old_model ?? 'Fallback model active',
      }
    case 'hb':
    case 'run_alive':
    case 'metrics':
    case 'promise_warning':
    case 'doc_update':
    case 'token.added':
    case 'token.resolved':
    case 'done':
      return turn
  }
}
