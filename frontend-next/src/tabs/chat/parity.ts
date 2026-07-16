import type { Bubble } from './reducer'

export interface BranchPrefixItem { id: string; role: Bubble['role']; text: string }

export function sliceBranchPrefix(thread: Bubble[], messageId: string): BranchPrefixItem[] | null {
  const index = thread.findIndex((message) => message.id === messageId)
  if (index < 0) return null
  return thread.slice(0, index + 1).map(({ id, role, text }) => ({ id, role, text }))
}

export function branchStorageKey(sessionId: string): string {
  return `next:branch-prefix:${sessionId}`
}

export function safeDownloadSlug(text: string): string {
  return (text.split('\n')[0] || 'message').slice(0, 40).replace(/[^\w.-]+/g, '_') || 'message'
}

