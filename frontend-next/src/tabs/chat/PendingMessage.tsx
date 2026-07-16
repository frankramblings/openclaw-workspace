import { useEffect, useState } from 'react'
import { Button } from '../../kit'
import { Md } from './Message'
import { useChatStore } from './store'

export function PendingMessage() {
  const activeId = useChatStore((state) => state.activeSessionId)
  const pending = useChatStore((state) => state.pendingSend)
  const update = useChatStore((state) => state.updatePending)
  const flush = useChatStore((state) => state.flushPending)
  const cancel = useChatStore((state) => state.cancelPending)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  useEffect(() => { setDraft(pending?.text ?? '') }, [pending?.text])
  if (!pending || pending.sessionId !== activeId) return null
  const save = () => {
    if (!draft.trim() && !(pending.opts.attachments?.length)) { cancel(); return }
    update(draft.trim())
    setEditing(false)
    queueMicrotask(flush)
  }
  return <article className="msg user next-pending-message" aria-label="Message waiting to send">
    <div className="msg-role">You · sending shortly</div>
    {editing ? <><textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save() } }} /><div className="next-pending-actions"><Button onClick={save}>Save & send</Button><Button variant="ghost" onClick={() => setEditing(false)}>Keep original</Button><Button variant="danger" onClick={cancel}>Cancel send</Button></div></> : <><Md src={pending.text} /><div className="next-pending-actions"><Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button><Button variant="ghost" onClick={flush}>Send now</Button><Button variant="danger" onClick={cancel}>Cancel</Button></div></>}
  </article>
}

