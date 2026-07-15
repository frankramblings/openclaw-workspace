import { create } from 'zustand'

export interface ToastItem {
  id: number
  msg: string
  kind: 'info' | 'ok' | 'err'
}

interface ToastState {
  toasts: ToastItem[]
  push: (msg: string, kind?: ToastItem['kind']) => void
  dismiss: (id: number) => void
}

let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export const useToasts = create<ToastState>((set) => {
  const remove = (id: number) => {
    const t = timers.get(id)
    if (t) { clearTimeout(t); timers.delete(id) }
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
  }
  return {
    toasts: [],
    push: (msg, kind = 'info') => {
      const id = nextId++
      set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }))
      timers.set(id, setTimeout(() => remove(id), 5000))
    },
    dismiss: remove,
  }
})

const DOT_COLOR: Record<ToastItem['kind'], string> = {
  info: 'var(--blue)',
  ok: 'var(--green)',
  err: 'var(--red)',
}

/** Fixed-position host; render once in the shell. Uses the classic .oc-toast
 *  look (host id included so ported CSS positions it). */
export function ToastHost() {
  const { toasts, dismiss } = useToasts()
  return (
    <div id="oc-toast-host">
      {toasts.map((t) => (
        <div key={t.id} className="oc-toast in" role="status" onClick={() => dismiss(t.id)}>
          <span className="oc-toast-dot" style={{ background: DOT_COLOR[t.kind] }} />
          <span className="oc-toast-msg">{t.msg}</span>
        </div>
      ))}
    </div>
  )
}
