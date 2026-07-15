import type { ReactNode } from 'react'

const TONE_CLASS = {
  accent: 'chip-teal',
  muted: 'chip-ghost',
} as const

export function Chip({ tone = 'muted', onRemove, children }: {
  tone?: keyof typeof TONE_CLASS
  onRemove?: () => void
  children: ReactNode
}) {
  return (
    <span className={TONE_CLASS[tone]}>
      {children}
      {onRemove && (
        <button type="button" className="chip-x" aria-label="Remove" onClick={onRemove}>×</button>
      )}
    </span>
  )
}
