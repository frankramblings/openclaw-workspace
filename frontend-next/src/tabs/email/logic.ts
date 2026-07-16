export function displayDate(value: string): string {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString()
}

export function composePayload(fields: { to: string; subject: string; body: string }, reply?: { message_id: string; references: string }) {
  return { ...fields, ...(reply ? { in_reply_to: reply.message_id, references: [reply.references, reply.message_id].filter(Boolean).join(' ') } : {}) }
}

