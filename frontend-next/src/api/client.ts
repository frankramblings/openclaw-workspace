// The one network layer. Mirrors the throw-on-non-2xx contract of the classic
// app's live/api.js (ApiError carries status + body for 502/503 handling), and
// adds the typed SSE-over-POST reader for /api/chat_stream.
//
// All paths are absolute same-origin ('/api/…') — /next shares cookies and the
// server-side auth gate with the classic app, so there is no auth logic here.
import { parseFrame, type ChatEvent } from './events'

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'ApiError'
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''))
  return res.json() as Promise<T>
}

export async function apiGet<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path))
}

export async function apiJson<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<T> {
  return handle<T>(await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

export async function apiForm<T>(path: string, fields: Record<string, string | Blob>, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return handle<T>(await fetch(path, { method, body: form }))
}

export async function apiDelete<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, { method: 'DELETE' }))
}

export interface StreamHandlers {
  onEvent(ev: ChatEvent): void
  /** Called exactly once: after the stream closes cleanly ([DONE] or EOF). */
  onDone(): void
  /** Called instead of onDone on network/HTTP failure. Aborts do NOT error. */
  onError(e: unknown): void
}

/** SSE-over-POST reader for /api/chat_stream. NOTE: aborting the returned
 *  controller only detaches THIS reader — the backend's detached recorder
 *  keeps the run alive; stopping a run is POST /api/chat/stop/{session_id}. */
export function postStream(path: string, form: FormData, handlers: StreamHandlers): AbortController {
  const ctrl = new AbortController()
  ;(async () => {
    let sawDone = false
    try {
      const res = await fetch(path, { method: 'POST', body: form, signal: ctrl.signal })
      if (!res.ok || !res.body) throw new ApiError(res.status, res.body ? await res.text().catch(() => '') : 'no body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue // id:/comment/blank lines
          const ev = parseFrame(line.slice(5))
          if (!ev) continue
          if (ev.type === 'done') sawDone = true
          handlers.onEvent(ev)
        }
      }
      handlers.onDone()
    } catch (e) {
      if (ctrl.signal.aborted) return // caller detached; not an error, not done
      if (sawDone) { handlers.onDone(); return }
      handlers.onError(e)
    }
  })()
  return ctrl
}

/** EventSource wrapper for GET SSE routes (jobs/tasks/research streams and
 *  chat resume tails). Passes the event id through for Last-Event-ID resume. */
export function openSSE(path: string, onEvent: (ev: ChatEvent, id?: string) => void): EventSource {
  const es = new EventSource(path)
  es.onmessage = (msg) => {
    const ev = parseFrame(String(msg.data ?? ''))
    if (ev) onEvent(ev, msg.lastEventId || undefined)
  }
  return es
}
