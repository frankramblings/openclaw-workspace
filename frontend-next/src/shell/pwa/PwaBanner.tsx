import { useState } from 'react'
import { Button } from '../../kit'
import { Icon } from '../../kit/icons'
import { usePwaStore } from './store'

const DISMISS_KEY = 'next-pwa-banner-dismissed'

function wasDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

export function PwaBanner() {
  const pwa = usePwaStore()
  const [dismissed, setDismissed] = useState(wasDismissed)
  const installNag = pwa.online && !pwa.updateReady && !pwa.error
  if (pwa.online && !pwa.updateReady && !pwa.installReady && !pwa.error) return null
  // The install prompt is a one-time suggestion, not a permanent fixture —
  // dismissable, and never shown again once waved away (offline/update
  // states still surface; they are transient and load-bearing).
  if (installNag && (dismissed || pwa.standalone)) return null
  const dismiss = () => {
    setDismissed(true)
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* view-only loss */ }
  }
  return <aside className={`next-pwa-banner${!pwa.online ? ' is-offline' : ''}${installNag ? ' is-install' : ''}`} role="status"><span>{!pwa.online ? 'Offline · showing the last cached workspace shell' : pwa.updateReady ? 'A new workspace version is ready' : pwa.error ? `Offline support unavailable · ${pwa.error}` : 'Install Workspace on this device'}</span>{pwa.updateReady && pwa.online && <Button onClick={() => void pwa.applyUpdate()}>Reload update</Button>}{pwa.installReady && pwa.online && !pwa.standalone && <Button variant="ghost" onClick={() => void pwa.install()}>Install</Button>}{installNag && <button type="button" className="next-pwa-dismiss" aria-label="Dismiss" onClick={dismiss}><Icon name="x" size={13} /></button>}</aside>
}
