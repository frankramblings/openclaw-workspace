export type AttachmentStatus = 'uploading' | 'failed'

export interface PendingAttachment {
  id: string
  name: string
  url?: string
  status?: AttachmentStatus
}

export function beginUploads(
  pending: PendingAttachment[],
  names: string[],
  mintId: () => string,
): { list: PendingAttachment[]; ids: string[] } {
  const list = [...pending]
  const ids = names.map((name) => {
    const id = mintId()
    list.push({ id, name: name || 'upload', status: 'uploading' })
    return id
  })
  return { list, ids }
}

export function resolveUploads(
  pending: PendingAttachment[], ids: string[], saved: PendingAttachment[],
): PendingAttachment[] {
  const byPosition = new Map(ids.map((id, index) => [id, saved[index]]))
  return pending.flatMap((item) => {
    if (!ids.includes(item.id)) return [item]
    const match = byPosition.get(item.id)
    return match
      ? [{ id: match.id, name: match.name || item.name, url: match.url }]
      : [{ ...item, status: 'failed' as const }]
  })
}

export function failUploads(pending: PendingAttachment[], ids: string[]): PendingAttachment[] {
  return pending.map((item) => ids.includes(item.id) ? { ...item, status: 'failed' } : item)
}

export function sendableAttach(pending: PendingAttachment[]): PendingAttachment[] {
  return pending.filter((item) => !item.status)
}

export function uploadGate(pending: PendingAttachment[]): 'uploading' | 'failed' | 'ok' {
  if (pending.some((item) => item.status === 'uploading')) return 'uploading'
  if (pending.some((item) => item.status === 'failed')) return 'failed'
  return 'ok'
}
