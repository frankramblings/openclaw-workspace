import { useMemo, useState } from 'react'
import { Button } from '../../kit'
import { Icon } from '../../kit/icons'
import { esc } from '../../lib/markdown'
import { safeDownloadSlug } from './parity'
import type { Bubble } from './reducer'
import { useChatStore } from './store'
import { renderThreadMarkdown, downloadMarkdown } from './exportMarkdown'

function transcriptText(bubbles: Bubble[], markdown = false): string {
  return bubbles.map((bubble) => {
    const speaker = bubble.role === 'user' ? 'You' : 'Gary'
    return markdown ? `**${speaker}:** ${bubble.text}` : `${speaker}: ${bubble.text}`
  }).join('\n\n')
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function ChatHeader({ onOpenConversations }: { onOpenConversations?: () => void } = {}) {
  const [notice, setNotice] = useState('')
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeSessionId)
  const history = useChatStore((state) => state.history)
  const live = useChatStore((state) => state.liveTurn)
  const prefix = useChatStore((state) => state.branchPrefix)
  const active = sessions.status === 'ready' ? sessions.data.find((session) => session.id === activeId) : null
  const bubbles = useMemo(() => [
    ...(prefix ?? []),
    ...(history.status === 'ready' ? history.data : history.status === 'loading' ? history.stale ?? [] : []),
    ...(live && live.status !== 'done' ? live.bubbles : []),
  ], [history, live, prefix])
  if (!activeId) return null

  // Export/copy affordances must be honestly gated on the CURRENT session's
  // history being settled, not merely on `bubbles.length`. While switching
  // sessions, loadHistory() sets history to {status:'loading', stale:
  // <PREVIOUS session's already-loaded data>} for one or more render
  // cycles before the new session's fetch resolves (see staleHistory() /
  // loadHistory() in store.ts) — so bubbles.length can be > 0 (from the
  // old session's stale data) while the header title already shows the
  // NEW session's name. Without this guard, a fast click during that
  // window exports the wrong session's transcript under the new session's
  // filename/title.
  const historyReady = history.status === 'ready'
  const exportDisabled = !historyReady || !bubbles.length

  const title = active?.name || 'Conversation'
  const safe = safeDownloadSlug(title) || 'conversation'
  const copy = async () => {
    try { await navigator.clipboard.writeText(transcriptText(bubbles)); setNotice('Copied') }
    catch { setNotice('Copy failed') }
  }
  const markdown = () => {
    // Convert Bubble format to HistoryBubble format for export
    const historyBubbles = bubbles.map(bubble => ({
      role: bubble.role as 'user' | 'assistant',
      text: bubble.text,
      attachments: bubble.attachments?.map(att => ({
        name: att.name,
        path: att.url || att.id,
      })),
    }))

    const markdown = renderThreadMarkdown(title, historyBubbles)
    downloadMarkdown(safe, markdown)
    setNotice('Markdown downloaded')
  }
  const pdf = async () => {
    setNotice('Preparing PDF…')
    const body = transcriptText(bubbles)
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:48px auto;color:#202124}h1{font-size:25px;border-bottom:1px solid #ddd;padding-bottom:12px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${esc(title)}</h1><pre>${esc(body)}</pre></body></html>`
    try {
      const response = await fetch('/api/export/pdf', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html, filename: `${safe}.pdf` }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      if (!blob.size) throw new Error('Empty PDF')
      downloadBlob(blob, `${safe}.pdf`)
      setNotice('PDF downloaded')
    } catch { setNotice('PDF export failed') }
  }

  return <header className="next-chat-header">
    {onOpenConversations && (
      <button type="button" className="next-chat-header-menu" aria-label="Conversations" onClick={onOpenConversations}>
        <Icon name="panelShow" size={16} />
      </button>
    )}
    <div className="next-chat-header-title"><h2>{title}</h2><p>{active?.model || 'Chat'} · {bubbles.length} messages</p></div>
    <div className="next-chat-header-actions">
      <Button variant="ghost" disabled={exportDisabled} onClick={() => void copy()}>Copy transcript</Button>
      <Button variant="ghost" disabled={exportDisabled} onClick={markdown}>Markdown</Button>
      <Button variant="ghost" disabled={exportDisabled} onClick={() => void pdf()}>PDF</Button>
      {notice && <span role="status">{notice}</span>}
    </div>
  </header>
}
