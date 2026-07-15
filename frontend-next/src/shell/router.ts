import { useSyncExternalStore, useCallback } from 'react'
import { TABS, DEFAULT_TAB } from '../tabs/registry'

// Hash routing, same scheme as the classic app: '#/chat', '#/inbox', …
// Unknown/empty hashes NORMALIZE to DEFAULT_TAB here, at the route level, so
// the route state always equals the rendered tab (rail highlight included).

export function tabFromHash(hash: string): string {
  const m = /^#\/([a-z-]+)/.exec(hash || '')
  const id = m ? m[1] : DEFAULT_TAB
  return TABS.some((t) => t.id === id) ? id : DEFAULT_TAB
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useHashRoute(): { tab: string; navigate: (tab: string) => void } {
  const tab = useSyncExternalStore(subscribe, () => tabFromHash(window.location.hash))
  const navigate = useCallback((next: string) => {
    window.location.hash = `#/${next}`
  }, [])
  return { tab, navigate }
}
