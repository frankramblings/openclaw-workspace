import { Icon } from './icons'
import { useEffect, useRef, type ReactNode } from 'react'
import { useHistoryLayer } from '../shell/useHistoryLayer'

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

// Stack of open modals; only the TOP modal responds to Escape, so nested
// modals close one layer at a time.
const modalStack: symbol[] = []

/** Focus-trapped modal. Esc (top of stack only) and backdrop click close.
 *  Focus is captured once per open, not on rerenders, and restored to the
 *  opener on close. */
export function Modal({ open, onClose, title, children }: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const close = useHistoryLayer(open, onClose)
  // Where a pointer gesture started, so drag-out (mousedown inside the box,
  // mouseup on the backdrop) doesn't count as a backdrop click.
  const pointerFrom = useRef<'backdrop' | 'box' | null>(null)

  useEffect(() => {
    if (!open) return
    const id = Symbol('modal')
    modalStack.push(id)
    const box = boxRef.current
    const opener = document.activeElement as HTMLElement | null
    const first = box?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? box)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (modalStack[modalStack.length - 1] !== id) return // not topmost
        e.stopPropagation()
        close()
        return
      }
      if (e.key !== 'Tab' || !box) return
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (!items.length) return
      const firstEl = items[0], lastEl = items[items.length - 1]
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus() }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const i = modalStack.indexOf(id)
      if (i >= 0) modalStack.splice(i, 1)
      opener?.focus()
    }
  }, [close, open])

  if (!open) return null
  return (
    <div
      className="next-modal-backdrop"
      role="presentation"
      onPointerDown={(e) => { pointerFrom.current = e.target === e.currentTarget ? 'backdrop' : 'box' }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pointerFrom.current === 'backdrop') close()
        pointerFrom.current = null
      }}
    >
      <div
        ref={boxRef}
        className="next-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="next-modal-head">
          <h3 className="next-modal-title">{title}</h3>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Close" onClick={close}><Icon name="x" size={14} /></button>
        </header>
        <div className="next-modal-body">{children}</div>
      </div>
    </div>
  )
}
