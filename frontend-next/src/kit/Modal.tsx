import { useEffect, useRef, type ReactNode } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

/** Focus-trapped modal. Esc and backdrop click close. */
export function Modal({ open, onClose, title, children }: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const box = boxRef.current
    const prev = document.activeElement as HTMLElement | null
    const first = box?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? box)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
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
      prev?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="next-modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={boxRef}
        className="next-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="next-modal-head">
          <h3 className="next-modal-title">{title}</h3>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <div className="next-modal-body">{children}</div>
      </div>
    </div>
  )
}
