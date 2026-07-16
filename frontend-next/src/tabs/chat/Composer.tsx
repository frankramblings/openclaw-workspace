import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Button, Chip } from '../../kit'
import { beginUploads, failUploads, resolveUploads, sendableAttach, uploadGate, type PendingAttachment } from './attachments'
import { useChatStore } from './store'
import { useSuggest } from './useSuggest'

let uploadSequence = 0

export function Composer() {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [notice, setNotice] = useState('')
  const [allowWebSearch, setAllowWebSearch] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const sessionId = useChatStore((state) => state.activeSessionId)
  const historyRemote = useChatStore((state) => state.history)
  const live = useChatStore((state) => state.liveTurn)
  const send = useChatStore((state) => state.send)
  const stop = useChatStore((state) => state.stop)
  const queued = useChatStore((state) => sessionId ? state.queuedSends[sessionId] : undefined)
  const recallQueued = useChatStore((state) => state.recallQueued)
  const cancelQueued = useChatStore((state) => state.cancelQueued)
  const enableNotifications = useChatStore((state) => state.enableNotifications)
  const history = historyRemote.status === 'ready' ? historyRemote.data : []
  const { suggestion, clearSuggestion } = useSuggest({ sessionId, history, liveTurn: live, draft })
  const working = live && ['sending', 'streaming', 'stalled'].includes(live.status)

  const submit = () => {
    const gate = uploadGate(attachments)
    if (gate !== 'ok') {
      setNotice(gate === 'uploading' ? 'Wait for attachments to finish uploading.' : 'Remove failed attachments before sending.')
      return
    }
    if (!draft.trim() && !attachments.length) return
    void enableNotifications()
    send(draft.trim(), {
      allowWebSearch,
      attachments: sendableAttach(attachments).map((item) => item.id),
    })
    setDraft('')
    setAttachments([])
    setNotice('')
    clearSuggestion()
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    const batch = beginUploads(attachments, files.map((file) => file.name), () => `upload-${++uploadSequence}`)
    setAttachments(batch.list)
    const form = new FormData()
    files.forEach((file) => form.append('files', file))
    try {
      const response = await fetch('/api/upload', { method: 'POST', body: form })
      if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status})`)
      const body = await response.json() as { files?: PendingAttachment[] }
      setAttachments((current) => resolveUploads(current, batch.ids, body.files || []))
    } catch {
      setAttachments((current) => failUploads(current, batch.ids))
      setNotice('One or more attachments failed to upload.')
    }
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && suggestion && !draft) {
      event.preventDefault()
      setDraft(suggestion)
      clearSuggestion()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <section className="composer" aria-label="Message composer">
      {queued && sessionId && <div className="next-queued-message"><button type="button" onClick={() => { const recalled = recallQueued(sessionId); if (recalled) setDraft(recalled.text) }}>Queued · {queued.text.slice(0, 80) || 'attachment'} · edit</button><button type="button" aria-label="Cancel queued message" onClick={() => cancelQueued(sessionId)}>×</button></div>}
      {attachments.length > 0 && <div className="composer-attachments">
        {attachments.map((item) => <Chip key={item.id} onRemove={() => setAttachments((all) => all.filter((entry) => entry.id !== item.id))}>
          {item.name}{item.status ? ` · ${item.status}` : ''}
        </Chip>)}
      </div>}
      {suggestion && !draft && <button className="ghost-suggest" type="button" onClick={() => { setDraft(suggestion); clearSuggestion() }}>
        {suggestion}<span className="tabhint">tab</span>
      </button>}
      <textarea
        value={draft}
        disabled={!sessionId}
        placeholder={sessionId ? 'Message Gary…' : 'Select a conversation first'}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={keyDown}
      />
      <input ref={fileInput} hidden type="file" multiple onChange={(event) => void upload(event)} />
      <div className="composer-actions">
        <Button variant="ghost" disabled={!sessionId} onClick={() => fileInput.current?.click()}>Attach</Button>
        <label className="composer-web-search">
          <input type="checkbox" checked={allowWebSearch} onChange={(event) => setAllowWebSearch(event.target.checked)} />
          Web search
        </label>
        {working
          ? <Button variant="danger" onClick={() => void stop()}>Stop</Button>
          : <Button variant="primary" disabled={!sessionId || (!draft.trim() && attachments.length === 0)} onClick={submit}>Send</Button>}
      </div>
      {notice && <p role="alert" className="next-error-detail">{notice}</p>}
    </section>
  )
}
