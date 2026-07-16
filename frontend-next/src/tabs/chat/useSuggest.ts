import { useEffect, useRef, useState } from 'react'
import { apiJson } from '../../api/client'
import { buildSuggestContext } from '../../lib/suggest-core'
import type { Bubble, Turn } from './reducer'

export function useSuggest({ sessionId, history, liveTurn, draft }: {
  sessionId: string | null
  history: Bubble[]
  liveTurn: Turn | null
  draft: string
}) {
  const [text, setText] = useState('')
  const asked = useRef('')

  useEffect(() => {
    if (draft.trim()) setText('')
  }, [draft])

  useEffect(() => {
    if (!sessionId || !liveTurn || liveTurn.status !== 'done' || draft.trim()) return
    const key = `${sessionId}:${liveTurn.turnId ?? 'done'}`
    if (asked.current === key) return
    const thread = [...history, ...liveTurn.bubbles]
    const context = buildSuggestContext(thread)
    if (!context) return
    asked.current = key
    let current = true
    void apiJson<{ text: string }>('POST', '/api/chat/suggest', {
      session_key: sessionId, mode: 'followup', context,
    }).then((result) => {
      if (current) setText(typeof result.text === 'string' ? result.text.trim() : '')
    }).catch(() => { if (current) setText('') })
    return () => { current = false }
  }, [draft, history, liveTurn, sessionId])

  return { suggestion: text, clearSuggestion: () => setText('') }
}
