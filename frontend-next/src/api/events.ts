// The exact SSE frame protocol emitted by backend/bridge.py + chat_turn.py
// (verified against source 2026-07-15). Frames arrive as `data: <json>` lines;
// the bare `data: [DONE]` is the terminal marker; resume tails prefix frames
// with `id: <eventId>`; `: keepalive` comment lines are noise.
//
// Discriminator is the `type` field EXCEPT text/image frames, which carry no
// `type` on the wire ({delta, thinking?} / {image_url, image_prompt}) and are
// normalized here to {type:'text'} / {type:'image'}.

export type ChatEvent =
  // turn_id is an INT on the wire (backend/turn_state.py); tool_id can be
  // absent or JSON null on bridge error cards — pairing code must tolerate it.
  | { type: 'turn_start'; turn_id: number; session_key: string; ts: number }
  | { type: 'turn_end'; turn_id: number; status: 'ok' | 'error' | 'aborted'; ts: number }
  | { type: 'hb'; turn_id: number; elapsed_ms: number }
  | { type: 'reply_reset' }
  | { type: 'agent_step' }
  | { type: 'run_alive' }
  | { type: 'tool_start'; tool: string; tool_id?: string | null; command?: string; round?: number; input?: unknown }
  | { type: 'tool_output'; tool: string; tool_id?: string | null; output: string; exit_code: 0 | 1 }
  | { type: 'stall'; silent_for: number }
  | { type: 'stall_retry' }
  | { type: 'model_fallback'; data: { old_model: string | null; new_model: string | null; reason: string | null; attempts: unknown[]; phase: 'active' | 'cleared' } }
  | { type: 'promise_warning'; phrase: string }
  | { type: 'metrics'; data: { response_time: number; agent_model_wait_time?: number; model?: string } }
  | { type: 'doc_update'; doc_id: string; content: string; version?: number; title?: string; language?: string }
  // Deferred-work tokens (backend/pending_tokens.py) ride the same event log
  // and arrive on POST tails and resume streams.
  | { type: 'token.added'; turn_id: number; token: string; token_id: string; payload?: unknown }
  | { type: 'token.resolved'; turn_id: number; token_id: string; elapsed_ms?: number; payload?: unknown }
  | { type: 'text'; delta: string; thinking: boolean }
  | { type: 'image'; url: string; prompt?: string }
  | { type: 'done' }

/** Parse one SSE line's payload (the part after `data: `). Returns null for
 *  anything unparseable (keepalive comments already filtered by the reader). */
export function parseFrame(payload: string): ChatEvent | null {
  const s = payload.trim()
  if (!s) return null
  if (s === '[DONE]') return { type: 'done' }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(s) as Record<string, unknown>
  } catch {
    return null
  }
  if (obj == null || typeof obj !== 'object') return null
  if (typeof obj.type === 'string') return obj as unknown as ChatEvent
  if (typeof obj.delta === 'string') {
    return { type: 'text', delta: obj.delta, thinking: obj.thinking === true }
  }
  if (typeof obj.image_url === 'string') {
    return { type: 'image', url: obj.image_url, prompt: typeof obj.image_prompt === 'string' ? obj.image_prompt : undefined }
  }
  return null
}
