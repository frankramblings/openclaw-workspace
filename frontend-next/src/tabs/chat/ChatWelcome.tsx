import { useAppStore } from '../../store/app'

// Classic redesign chat welcome (surfaces.js chatWelcome): Gary avatar, name,
// "/ for commands" hint, quick chips that FILL the composer (never auto-send).
const QUICK_CHIPS = [
  'What can you do?',
  'Summarize my recent sessions',
  'Help me configure a channel',
  'Check system health',
]

/** Composer listens for this to receive chip text (its draft is local state). */
export const FILL_COMPOSER_EVENT = 'next:fill-composer'

export function ChatWelcome() {
  const config = useAppStore((s) => s.config)
  const agentName = config.status === 'ready' ? config.data.agent_name : '…'
  return (
    <div className="chat-welcome">
      <div className="cw-av"><img src="/static/redesign-assets/gary-outline.png" alt={agentName} decoding="sync" loading="eager" /></div>
      <div className="cw-name">{agentName}</div>
      <div className="cw-hint">Type a message below&ensp;·&ensp;<kbd>/</kbd> for commands</div>
      <div className="cw-chips">
        {QUICK_CHIPS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="qchip occhip"
            onClick={() => window.dispatchEvent(new CustomEvent(FILL_COMPOSER_EVENT, { detail: prompt }))}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}
