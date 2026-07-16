import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Button, Chip } from '../../kit'
import { beginUploads, failUploads, resolveUploads, sendableAttach, uploadGate, type PendingAttachment } from './attachments'
import { useChatStore } from './store'
import { useSuggest } from './useSuggest'
import { filterSlashCommands } from './slash'

let uploadSequence = 0

export function Composer() {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [notice, setNotice] = useState('')
  const [allowWebSearch, setAllowWebSearch] = useState(false)
  const [slashForced, setSlashForced] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const sessionId = useChatStore((state) => state.activeSessionId)
  const historyRemote = useChatStore((state) => state.history)
  const live = useChatStore((state) => state.liveTurn)
  const send = useChatStore((state) => state.send)
  const stop = useChatStore((state) => state.stop)
  const queue = useChatStore((state) => sessionId ? state.queuedSends[sessionId] : undefined)
  const queued = queue?.[0]
  const recallQueued = useChatStore((state) => state.recallQueued)
  const cancelQueued = useChatStore((state) => state.cancelQueued)
  const enableNotifications = useChatStore((state) => state.enableNotifications)
  const usage = useChatStore((state) => state.usage)
  const history = historyRemote.status === 'ready' ? historyRemote.data : []
  const { suggestion, clearSuggestion } = useSuggest({ sessionId, history, liveTurn: live, draft })
  const working = live && ['sending', 'streaming', 'stalled'].includes(live.status)
  const context = usage.status === 'ready' && usage.data.ok ? usage.data.context : null
  const contextPct = context && Number.isFinite(context.usedPct) ? Math.max(0, Math.min(100, context.usedPct)) : null
  const slashCommands = slashDismissed ? [] : filterSlashCommands(draft, slashForced)

  const chooseSlash = (index: number) => {
    const command = slashCommands[index]
    if (!command) return
    setDraft(`${command.name} `)
    setSlashForced(false)
    setSlashDismissed(false)
    setSlashIndex(0)
  }

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
      attachments: sendableAttach(attachments),
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
    if (slashCommands.length && event.key === 'ArrowDown') {
      event.preventDefault(); setSlashIndex((index) => (index + 1) % slashCommands.length); return
    }
    if (slashCommands.length && event.key === 'ArrowUp') {
      event.preventDefault(); setSlashIndex((index) => (index - 1 + slashCommands.length) % slashCommands.length); return
    }
    if (slashCommands.length && event.key === 'Escape') {
      event.preventDefault(); setSlashDismissed(true); return
    }
    if (slashCommands.length && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); chooseSlash(Math.min(slashIndex, slashCommands.length - 1)); return
    }
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
      {slashCommands.length > 0 && <div className="slash-menu" role="listbox" aria-label="Slash commands">
        <div className="hd">COMMANDS</div>
        {slashCommands.map((command, index) => <button type="button" role="option" aria-selected={index === slashIndex} className={`slash-cmd${index === slashIndex ? ' sel' : ''}`} key={command.name} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSlash(index)}>
          <span className="glyph">{command.glyph}</span><span className="name">{command.name}</span><span className="desc">{command.description}</span>
        </button>)}
      </div>}
      {queued && sessionId && <div className="next-queued-message"><button type="button" onClick={() => { const recalled = recallQueued(sessionId); if (recalled) setDraft(recalled.text) }}>Queued{queue!.length > 1 ? ` (${queue!.length})` : ''} · {queued.text.slice(0, 80) || 'attachment'} · edit</button><button type="button" aria-label="Cancel queued message" onClick={() => cancelQueued(sessionId)}>×</button></div>}
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
        onChange={(event) => { setDraft(event.target.value); setSlashForced(false); setSlashDismissed(false); setSlashIndex(0) }}
        onKeyDown={keyDown}
      />
      <input ref={fileInput} hidden type="file" multiple onChange={(event) => void upload(event)} />
      <div className="composer-actions">
        <Button variant="ghost" disabled={!sessionId} title="Slash commands" onClick={() => { setSlashForced((open) => !open); setSlashDismissed(false); setSlashIndex(0) }}>/</Button>
        <Button variant="ghost" disabled={!sessionId} onClick={() => fileInput.current?.click()}>Attach</Button>
        <label className="composer-web-search">
          <input type="checkbox" checked={allowWebSearch} onChange={(event) => setAllowWebSearch(event.target.checked)} />
          Web search
        </label>
        {contextPct !== null && <div className="ctx-meter" title={`${context!.usedTokens.toLocaleString()} of ${context!.windowTokens.toLocaleString()} context tokens`}>
          <span className="track"><span className="fill" style={{ width: `${contextPct}%` }} /></span>
          <span className="pct">{Math.round(contextPct)}%</span>
        </div>}
        {working
          ? <Button variant="danger" onClick={() => void stop()}>Stop</Button>
          : <Button variant="primary" disabled={!sessionId || (!draft.trim() && attachments.length === 0)} onClick={submit}>Send</Button>}
      </div>
      {notice && <p role="alert" className="next-error-detail">{notice}</p>}
    </section>
  )
}
