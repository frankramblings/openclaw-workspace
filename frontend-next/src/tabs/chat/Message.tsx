import { useState, useEffect, useRef } from 'react'
import { renderMarkdown } from '../../lib/markdown'
import { enhanceMessageEl } from '../../lib/enhance'
import { ActivityTrail } from './ActivityTrail'
import { ThinkBlock } from './ThinkBlock'
import { safeDownloadSlug } from './parity'
import type { Bubble } from './reducer'
import { useChatStore } from './store'
import { useWorkspaceStore } from '../../shell/workspace/store'
import { flattenModels } from './ModelPicker'

// Pending "restore the copy button's label" timers, keyed per-button so a
// rapid second click on the same button can cancel-and-reschedule instead of
// racing: without this, capturing `btn.textContent` as the "original" label
// at click time reads whatever the FIRST click already wrote ("Copied"), and
// the second click's own restore timer then permanently re-applies that
// wrong captured value after the first timer has already correctly reset it.
const copyLabelTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()

/** The one sanctioned rendered-markdown boundary. renderMarkdown is an
 * escape-first pipeline covered by the shared markdown tests. */
export function Md({ src, streaming }: { src: string; streaming?: boolean }) {
  const openPath = useWorkspaceStore((state) => state.openPath)
  const mdRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mdRef.current) {
      void enhanceMessageEl(mdRef.current, { streaming: streaming ?? false })
    }
  }, [src, streaming])

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!target) return

    const act = target.dataset.act
    const arg = target.dataset.arg

    switch (act) {
      case 'wsOpenFile':
        if (arg) void openPath(arg, target.dataset.root)
        break
      case 'codeCopy': {
        const codeCard = target.closest('.code-card')
        if (codeCard) {
          const codeEl = codeCard.querySelector('code')
          if (codeEl) {
            // Raw text, not innerHTML: after hljs highlighting the element
            // contains nested <span class="hljs-*"> wrapper tags, so reading
            // innerHTML would copy markup instead of code. textContent walks
            // text nodes only, giving back the exact original source text.
            const text = codeEl.textContent ?? ''
            const btn = target as HTMLButtonElement
            // Concurrent-click guard: capture the resting label once (not on
            // every click, which could capture an already-mutated "Copied").
            if (btn.dataset.restLabel === undefined) btn.dataset.restLabel = btn.textContent ?? 'Copy'
            const restLabel = btn.dataset.restLabel
            const pending = copyLabelTimers.get(btn)
            if (pending) clearTimeout(pending)
            const scheduleRestore = () => {
              const t = setTimeout(() => {
                btn.textContent = restLabel
                delete btn.dataset.restLabel
                copyLabelTimers.delete(btn)
              }, 1500)
              copyLabelTimers.set(btn, t)
            }
            void navigator.clipboard.writeText(text).then(() => {
              btn.textContent = 'Copied'
              scheduleRestore()
            }).catch(() => {
              btn.textContent = 'Copy failed'
              scheduleRestore()
            })
          }
        }
        break
      }
      case 'codeExpand': {
        const codeCard = target.closest('.code-card')
        if (codeCard) {
          codeCard.classList.remove('collapsed')
          target.remove()
        }
        break
      }
    }
  }

  return <div ref={mdRef} className="msg-markdown" onClick={handleClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />
}

export function Message({ bubble, streaming }: { bubble: Bubble; streaming?: boolean }) {
  const [notice, setNotice] = useState('')
  const [editText, setEditText] = useState(bubble.text)
  const [editPending, setEditPending] = useState(false)
  const [retryMenuOpen, setRetryMenuOpen] = useState(false)
  const editingMessageId = useChatStore((state) => state.editingMessageId)
  const startEdit = useChatStore((state) => state.startEdit)
  const cancelEdit = useChatStore((state) => state.cancelEdit)
  const editMessage = useChatStore((state) => state.editMessage)
  const branch = useChatStore((state) => state.branchFromMessage)
  const regenerate = useChatStore((state) => state.regenerate)
  const continueFrom = useChatStore((state) => state.continueFrom)
  const models = useChatStore((state) => state.models)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const sessions = useChatStore((state) => state.sessions)
  const copy = async () => {
    try { await navigator.clipboard.writeText(bubble.text); setNotice('Copied') }
    catch { setNotice('Copy failed') }
  }
  const download = () => {
    const blob = new Blob([bubble.text], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${bubble.role === 'user' ? 'you' : 'gary'}-${safeDownloadSlug(bubble.text)}.md`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  const pdf = async () => {
    const safe = `${bubble.role === 'user' ? 'you' : 'gary'}-${safeDownloadSlug(bubble.text)}`
    const body = bubble.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:48px auto}pre{font:inherit;white-space:pre-wrap}</style></head><body><h1>${bubble.role === 'user' ? 'You' : 'Gary'}</h1><pre>${body}</pre></body></html>`
    try {
      const response = await fetch('/api/export/pdf', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html, filename: `${safe}.pdf` }) })
      if (!response.ok) throw new Error()
      const blob = await response.blob()
      if (!blob.size) throw new Error()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${safe}.pdf`; document.body.appendChild(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
      setNotice('PDF downloaded')
    } catch { setNotice('PDF failed') }
  }
  const handleEditStart = () => {
    setEditText(bubble.text)
    startEdit(bubble.id)
  }
  const handleEditCancel = () => {
    setEditText(bubble.text)
    cancelEdit()
  }
  const handleEditSave = async () => {
    if (!editText.trim() && !(bubble.attachments?.length)) return
    setEditPending(true)
    const success = await editMessage(bubble.id, editText)
    setEditPending(false)
    if (!success) {
      setEditText(editText)
    }
  }
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleEditSave()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      handleEditCancel()
    }
  }
  const taRef = useRef<HTMLTextAreaElement>(null)
  const retryMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (editingMessageId === bubble.id && taRef.current) {
      taRef.current.focus()
    }
  }, [editingMessageId, bubble.id])
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (retryMenuRef.current && !retryMenuRef.current.contains(e.target as Node)) {
        setRetryMenuOpen(false)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRetryMenuOpen(false)
    }
    if (retryMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('keydown', handleEscape)
      }
    }
  }, [retryMenuOpen])
  const handleRetryWithModel = async (model: string, endpointId: string) => {
    setRetryMenuOpen(false)
    await regenerate(bubble.id, { model, endpointId })
  }
  const activeSession = sessions.status === 'ready' ? sessions.data.find((s) => s.id === activeSessionId) : undefined
  const modelChoices = models.status === 'ready' ? flattenModels(models.data) : []
  if (editingMessageId === bubble.id && bubble.role === 'user') {
    return (
      <article className="msg user msg-editing" data-message-id={bubble.id}>
        <div className="msg-role">You</div>
        <textarea
          ref={taRef}
          className="msg-edit-ta"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={editPending}
        />
        {(bubble.attachments ?? []).length > 0 && <div className="msg-attachments" aria-label="Attachments">{bubble.attachments!.map((attachment) => attachment.url
          ? <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer">📎 {attachment.name}</a>
          : <span key={attachment.id}>📎 {attachment.name}</span>)}</div>}
        <div className="msg-edit-bar">
          <button className="ocbtn" type="button" onClick={handleEditCancel} disabled={editPending}>Cancel</button>
          <button className="ocbtn msg-edit-save" type="button" onClick={() => void handleEditSave()} disabled={editPending || (!editText.trim() && !bubble.attachments?.length)}>Save</button>
        </div>
      </article>
    )
  }

  return (
    <article className={`msg ${bubble.role}`} data-message-id={bubble.id}>
      <div className="msg-role">{bubble.role === 'user' ? 'You' : 'Gary'}</div>
      <ThinkBlock text={bubble.thinking} />
      <ActivityTrail cards={bubble.cards} />
      {bubble.text && <Md src={bubble.text} streaming={streaming} />}
      {bubble.images.map((image) => (
        <figure key={image.url} className="msg-image">
          <img src={image.url} alt={image.prompt || 'Generated image'} />
          {image.prompt && <figcaption>{image.prompt}</figcaption>}
        </figure>
      ))}
      {(bubble.attachments ?? []).length > 0 && <div className="next-message-attachments" aria-label="Attachments">{bubble.attachments!.map((attachment) => attachment.url
        ? <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer">📎 {attachment.name}</a>
        : <span key={attachment.id}>📎 {attachment.name}</span>)}</div>}
      {bubble.text && <div className="msg-tools" aria-label="Message actions">
        <button className="msg-tool" type="button" title="Copy message" onClick={() => void copy()} aria-label="Copy message"><span aria-hidden="true">⧉</span></button>
        <button className="msg-tool" type="button" title="Branch conversation here" onClick={() => void branch(bubble.id)} aria-label="Branch here"><span aria-hidden="true">↳</span></button>
        <button className="msg-tool" type="button" title="Download Markdown" onClick={download} aria-label="Download message"><span aria-hidden="true">↓</span></button>
        <button className="msg-tool" type="button" title="Download PDF" onClick={() => void pdf()} aria-label="Download message as PDF"><span aria-hidden="true">PDF</span></button>
        {bubble.role === 'user' && <button className="msg-tool" type="button" title="Edit message" onClick={handleEditStart} aria-label="Edit message"><span aria-hidden="true">✎</span></button>}
        {bubble.role === 'assistant' && <div style={{ position: 'relative' }} ref={retryMenuRef}>
          <button className="msg-tool" type="button" title="Retry options" onClick={() => setRetryMenuOpen(!retryMenuOpen)} aria-label="Retry options"><span aria-hidden="true">↻</span></button>
          {retryMenuOpen && <div className="msg-retry-menu" role="menu">
            <button className="msg-retry-item" type="button" onClick={() => void regenerate(bubble.id)} role="menuitem">Retry</button>
            {modelChoices.map((choice) => (
              <button
                key={choice.id}
                className={`msg-retry-item ${activeSession?.model === choice.model ? 'active' : ''}`}
                type="button"
                onClick={() => void handleRetryWithModel(choice.model, choice.endpointId)}
                disabled={choice.offline}
                role="menuitem"
              >
                {choice.label}{choice.offline ? ' · offline' : ''}
              </button>
            ))}
          </div>}
          <button className="msg-tool" type="button" title="Continue response" onClick={() => continueFrom(bubble.id)} aria-label="Continue response"><span aria-hidden="true">▸</span></button>
        </div>}
        {notice && <span role="status" className="msg-tool-status">{notice}</span>}
      </div>}
    </article>
  )
}
