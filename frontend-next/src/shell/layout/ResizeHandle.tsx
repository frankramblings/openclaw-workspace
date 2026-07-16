import { useRef, type PointerEvent } from 'react'

export function ResizeHandle({ axis, value, onChange, invert = false, label }: {
  axis: 'x' | 'y'
  value: number
  onChange(value: number): void
  invert?: boolean
  label: string
}) {
  const start = useRef({ point: 0, value: 0 })
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const target = event.currentTarget
    start.current = { point: axis === 'x' ? event.clientX : event.clientY, value }
    target.setPointerCapture(event.pointerId)
    const move = (next: globalThis.PointerEvent) => {
      const point = axis === 'x' ? next.clientX : next.clientY
      onChange(start.current.value + (point - start.current.point) * (invert ? -1 : 1))
    }
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up) }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
  return <div className={`next-resize-handle is-${axis}`} role="separator" aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} tabIndex={0} onPointerDown={pointerDown} onKeyDown={event => {
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -12 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 12 : 0
    if (!delta) return
    event.preventDefault()
    onChange(value + delta * (invert ? -1 : 1))
  }} />
}
