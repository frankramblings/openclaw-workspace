import { Button } from '../../kit'
import { usePwaStore } from './store'

export function PwaBanner() {
  const pwa = usePwaStore()
  if (pwa.online && !pwa.updateReady && !pwa.installReady && !pwa.error) return null
  return <aside className={`next-pwa-banner${!pwa.online ? ' is-offline' : ''}`} role="status"><span>{!pwa.online ? 'Offline · showing the last cached workspace shell' : pwa.updateReady ? 'A new workspace version is ready' : pwa.error ? `Offline support unavailable · ${pwa.error}` : 'Install Workspace on this device'}</span>{pwa.updateReady && pwa.online && <Button onClick={() => void pwa.applyUpdate()}>Reload update</Button>}{pwa.installReady && pwa.online && !pwa.standalone && <Button variant="ghost" onClick={() => void pwa.install()}>Install</Button>}</aside>
}
