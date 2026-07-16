import { useMemo, useState } from 'react'
import { Button } from '../../kit'
import { esc } from '../../lib/markdown'
import { safeDownloadSlug } from './parity'
import type { Bubble } from './reducer'
import { useChatStore } from './store'

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

export function ChatHeader() {
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

  const title = active?.name || 'Conversation'
  const safe = safeDownloadSlug(title) || 'conversation'
  const copy = async () => {
    try { await navigator.clipboard.writeText(transcriptText(bubbles)); setNotice('Copied') }
    catch { setNotice('Copy failed') }
  }
  const markdown = () => {
    downloadBlob(new Blob([`# ${title}\n\n${transcriptText(bubbles, true)}`], { type: 'text/markdown' }), `${safe}.md`)
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
    <div><h2>{title}</h2><p>{active?.model || 'Chat'} · {bubbles.length} messages</p></div>
    <div className="next-chat-header-actions">
      <Button variant="ghost" disabled={!bubbles.length} onClick={() => void copy()}>Copy transcript</Button>
      <Button variant="ghost" disabled={!bubbles.length} onClick={markdown}>Markdown</Button>
      <Button variant="ghost" disabled={!bubbles.length} onClick={() => void pdf()}>PDF</Button>
      {notice && <span role="status">{notice}</span>}
    </div>
  </header>
}
