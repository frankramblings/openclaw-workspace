import { useCallback, useEffect, useRef } from 'react'

const STATE_KEY = '__nextHistoryLayers'
let sequence = 0

function layers(): string[] {
  const value = history.state?.[STATE_KEY]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function write(next: string[], mode: 'push' | 'replace') {
  const state = { ...(history.state ?? {}), [STATE_KEY]: next }
  history[`${mode}State`](state, '', location.href)
}

/** Add a same-route browser-history entry for transient UI. */
export function useHistoryLayer(open: boolean, onClose: () => void): () => void {
  const id = useRef(`next-layer-${++sequence}`).current
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const close = useCallback(() => {
    const current = layers()
    const index = current.lastIndexOf(id)
    if (index >= 0) {
      write(current.filter((_, item) => item !== index), 'replace')
      history.back()
    }
    onCloseRef.current()
  }, [id])

  useEffect(() => {
    if (!open) return
    if (!layers().includes(id)) write([...layers(), id], 'push')
    const onPopState = () => {
      if (!layers().includes(id)) onCloseRef.current()
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      const current = layers()
      const index = current.lastIndexOf(id)
      if (index >= 0) {
        write(current.filter((_, item) => item !== index), 'replace')
        history.back()
      }
    }
  }, [id, open])

  return close
}
