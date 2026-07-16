import { useEffect, useRef, useState, type DragEvent } from 'react'
import { apiJson } from '../../api/client'
import { Button } from '../../kit'
import { useChatStore } from '../../tabs/chat/store'
import { useTerminalPanel } from './store'
import { useHistoryLayer } from '../useHistoryLayer'

interface XTerminal { open(el: HTMLElement): void; loadAddon(addon: unknown): void; onData(fn: (data: string) => void): void; write(data: string): void; reset(): void; cols: number; rows: number; focus(): void }
interface FitAddonLike { fit(): void }
declare global { interface Window { Terminal?: new (options: Record<string, unknown>) => XTerminal; FitAddon?: { FitAddon: new () => FitAddonLike } } }

let assets: Promise<void> | null = null
function loadAssets(): Promise<void> {
  if (assets) return assets
  assets = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-next-xterm]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/static/js/vendor/xterm/xterm.css'; link.dataset.nextXterm = '1'; document.head.appendChild(link) }
    const load = (src: string) => new Promise<void>((ok, fail) => { if (document.querySelector(`script[src="${src}"]`)) { ok(); return } const script = document.createElement('script'); script.src = src; script.onload = () => ok(); script.onerror = () => fail(new Error(`Could not load ${src}`)); document.head.appendChild(script) })
    load('/static/js/vendor/xterm/xterm.js').then(() => load('/static/js/vendor/xterm/addon-fit.js')).then(resolve, reject)
  })
  return assets
}

export function TerminalPanel() {
  const panel = useTerminalPanel()
  const close = useHistoryLayer(panel.open, panel.close)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeSessionId)
  const mount = useRef<HTMLDivElement>(null), term = useRef<XTerminal | null>(null), fit = useRef<FitAddonLike | null>(null), socket = useRef<WebSocket | null>(null), retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [status, setStatus] = useState('closed'), [persist, setPersist] = useState(true)
  const records = sessions.status === 'ready' ? sessions.data.filter((session) => !session.archived) : []
  const activeKey = records.find((session) => session.id === activeId)?.sessionKey
  const key = panel.sessionKey || activeKey || records[0]?.sessionKey || null

  useEffect(() => { if (panel.open && !panel.sessionKey && activeKey) panel.choose(activeKey) }, [activeKey, panel.open, panel.sessionKey, panel.choose])
  useEffect(() => {
    if (!panel.open || !key || !mount.current) return
    let cancelled = false
    const connect = async () => {
      await loadAssets(); if (cancelled || !mount.current || !window.Terminal || !window.FitAddon) return
      if (!term.current) { term.current = new window.Terminal({ cursorBlink: true, convertEol: true, scrollback: 10_000, fontFamily: 'MonoLisa, ui-monospace, monospace', fontSize: 13, theme: { background: '#101115', foreground: '#dfe2e8', cursor: '#4fe3d1' } }); fit.current = new window.FitAddon.FitAddon(); term.current.loadAddon(fit.current); term.current.open(mount.current); term.current.onData((data) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'input', data })) }) } else term.current.reset()
      fit.current?.fit(); const proto = location.protocol === 'https:' ? 'wss' : 'ws'; const ws = new WebSocket(`${proto}://${location.host}/api/terminal/${encodeURIComponent(key)}/stream`); socket.current = ws; setStatus('connecting')
      ws.onopen = () => { if (cancelled) return; setStatus('connected'); fit.current?.fit(); ws.send(JSON.stringify({ type: 'resize', cols: term.current?.cols, rows: term.current?.rows })); term.current?.focus() }
      ws.onmessage = (event) => { try { const message = JSON.parse(String(event.data)) as { type: string; data?: string; code?: number }; if (message.type === 'output') term.current?.write(message.data || ''); if (message.type === 'exit') { term.current?.write(`\r\n[process exited${message.code == null ? '' : ` ${message.code}`}]\r\n`); setStatus('exited') } } catch { /* malformed frame */ } }
      ws.onclose = () => { if (cancelled) return; setStatus('reconnecting'); retry.current = setTimeout(connect, 1_500) }; ws.onerror = () => setStatus('disconnected')
      fetch(`/api/terminal/${encodeURIComponent(key)}/persist`).then((response) => response.json()).then((body: { enabled?: boolean }) => setPersist(body.enabled !== false)).catch(() => {})
    }
    void connect(); const resize = new ResizeObserver(() => { fit.current?.fit(); if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'resize', cols: term.current?.cols, rows: term.current?.rows })) }); resize.observe(mount.current)
    return () => { cancelled = true; resize.disconnect(); if (retry.current) clearTimeout(retry.current); retry.current = null; if (socket.current) { socket.current.onclose = null; socket.current.close(); socket.current = null } }
  }, [key, panel.open])

  const drop = async (event: DragEvent) => { event.preventDefault(); if (!key || !event.dataTransfer.files.length) return; const form = new FormData(); Array.from(event.dataTransfer.files).forEach((file) => form.append('files', file)); const response = await fetch('/api/upload', { method: 'POST', body: form }); if (!response.ok) return; const body = await response.json() as { files: Array<{ id: string; name: string }> }; for (const file of body.files ?? []) { const attached = await apiJson<{ token: string }>('POST', `/api/terminal/${encodeURIComponent(key)}/attach`, { file_id: file.id, name: file.name }); if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'input', data: attached.token })) } }

  return <aside className={`next-terminal-panel${panel.open ? ' is-open' : ''}`} aria-label="Terminal"><header><strong>Terminal</strong><select aria-label="Terminal conversation" value={key || ''} onChange={(event) => panel.choose(event.target.value)}>{records.map((session) => <option key={session.id} value={session.sessionKey}>{session.name}</option>)}</select><span className={`next-term-status is-${status}`}>{status}</span><label><input type="checkbox" checked={persist} disabled={!key} onChange={(event) => { const enabled = event.target.checked; setPersist(enabled); if (key) void apiJson('POST', `/api/terminal/${encodeURIComponent(key)}/persist`, { enabled }) }} /> persist</label><Button variant="ghost" disabled={!key} onClick={() => { if (key && confirm('Clear saved terminal scrollback?')) { term.current?.reset(); void apiJson('POST', `/api/terminal/${encodeURIComponent(key)}/clear-history`, {}) } }}>Clear</Button><Button variant="danger" disabled={!key} onClick={() => { if (key && confirm('Close this terminal process?')) void apiJson('POST', `/api/terminal/${encodeURIComponent(key)}/close`, {}) }}>Kill</Button><Button variant="ghost" onClick={close}>Close</Button></header><div ref={mount} className="next-terminal-mount" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void drop(event)} /></aside>
}
