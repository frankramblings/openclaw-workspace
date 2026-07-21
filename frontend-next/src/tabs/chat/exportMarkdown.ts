/**
 * Thread markdown export utility.
 *
 * Renders a chat thread to markdown format with proper formatting:
 * - ## User / ## Gary (or Assistant) headings per bubble
 * - Code fences preserved verbatim (including those containing ## lines)
 * - Attachments listed as [name](path) lines
 * - Blank line separation between bubbles
 * - No refetch; uses store's loaded history only
 */

export interface HistoryBubble {
  role: 'user' | 'assistant'
  text?: string
  attachments?: Array<{ filename?: string; path?: string; name?: string }>
}

/**
 * Render a thread history to markdown.
 *
 * @param sessionName Name of the session (becomes the ## title)
 * @param bubbles History bubbles from the chat store
 * @returns Markdown string ready to download
 */
export function renderThreadMarkdown(
  sessionName: string,
  bubbles: HistoryBubble[]
): string {
  const lines: string[] = []

  // Add session title
  lines.push(`# ${escapeMarkdownHeading(sessionName)}`)
  lines.push('')

  // Process each bubble
  for (const bubble of bubbles) {
    // Role heading
    const roleName = bubble.role === 'user' ? 'User' : 'Gary'
    lines.push(`## ${roleName}`)
    lines.push('')

    // Message text (verbatim, including code fences)
    if (bubble.text) {
      lines.push(bubble.text)
    }

    // Attachments
    if (bubble.attachments && bubble.attachments.length > 0) {
      if (bubble.text) {
        lines.push('')
      }
      for (const attachment of bubble.attachments) {
        const name = attachment.name || attachment.filename || 'attachment'
        const path = attachment.path || '#'
        lines.push(`[${name}](${path})`)
      }
    }

    // Blank line between bubbles
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Escape a session name for use as a markdown heading.
 * Markdown headings are sensitive to # at the start of content.
 */
function escapeMarkdownHeading(text: string): string {
  // If the text starts with #, we need to escape it somehow.
  // Since we're using # as the heading prefix, just escape inner # with backslash.
  return text.replace(/^#+/, (match) => `\\${match}`)
}

/**
 * Trigger a browser download of markdown text.
 *
 * @param filename Name for the file (will have .md appended if not present)
 * @param text Markdown content to download
 */
export function downloadMarkdown(filename: string, text: string): void {
  // Sanitize filename: keep only alphanumeric, dash, underscore, space
  const sanitized = filename
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 100) || 'chat'

  const finalName = sanitized.endsWith('.md') ? sanitized : `${sanitized}.md`

  // Create blob and download
  const blob = new Blob([text], { type: 'text/markdown; charset=utf-8' })
  const url = URL.createObjectURL(blob)

  try {
    const link = document.createElement('a')
    link.href = url
    link.download = finalName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  } finally {
    // Revoke the object URL to free memory
    URL.revokeObjectURL(url)
  }
}
