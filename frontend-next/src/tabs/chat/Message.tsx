import { renderMarkdown } from '../../lib/markdown'
import { ActivityTrail } from './ActivityTrail'
import { ThinkBlock } from './ThinkBlock'
import type { Bubble } from './reducer'

/** The one sanctioned rendered-markdown boundary. renderMarkdown is an
 * escape-first pipeline covered by the shared markdown tests. */
export function Md({ src }: { src: string }) {
  return <div className="msg-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />
}

export function Message({ bubble }: { bubble: Bubble }) {
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
    </article>
  )
}
