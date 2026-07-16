import { useState } from 'react'
import { renderMarkdown } from '../../lib/markdown'
import { ActivityTrail } from './ActivityTrail'
import { ThinkBlock } from './ThinkBlock'
import { safeDownloadSlug } from './parity'
import type { Bubble } from './reducer'
import { useChatStore } from './store'

/** The one sanctioned rendered-markdown boundary. renderMarkdown is an
 * escape-first pipeline covered by the shared markdown tests. */
export function Md({ src }: { src: string }) {
  return <div className="msg-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />
}

export function Message({ bubble }: { bubble: Bubble }) {
  const [notice, setNotice] = useState('')
  const branch = useChatStore((state) => state.branchFromMessage)
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
  return (
    <article className={`msg ${bubble.role}`} data-message-id={bubble.id}>
      <div className="msg-role">{bubble.role === 'user' ? 'You' : 'Gary'}</div>
      <ThinkBlock text={bubble.thinking} />
      <ActivityTrail cards={bubble.cards} />
      {bubble.text && <Md src={bubble.text} />}
      {bubble.images.map((image) => (
        <figure key={image.url} className="msg-image">
          <img src={image.url} alt={image.prompt || 'Generated image'} />
          {image.prompt && <figcaption>{image.prompt}</figcaption>}
        </figure>
      ))}
      {bubble.text && <div className="msg-tools" aria-label="Message actions">
        <button className="msg-tool" type="button" title="Copy message" onClick={() => void copy()} aria-label="Copy message"><span aria-hidden="true">⧉</span></button>
        <button className="msg-tool" type="button" title="Branch conversation here" onClick={() => void branch(bubble.id)} aria-label="Branch here"><span aria-hidden="true">↳</span></button>
        <button className="msg-tool" type="button" title="Download Markdown" onClick={download} aria-label="Download message"><span aria-hidden="true">↓</span></button>
        {notice && <span role="status" className="msg-tool-status">{notice}</span>}
      </div>}
    </article>
  )
}
