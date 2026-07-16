import type { ReactNode } from 'react'

// Maps onto the ported design language: .btn is the base, .btn-teal is the
// filled accent (primary), .btn-ghost the quiet variant. "danger" borrows the
// base with the red token, matching classic destructive buttons.
const VARIANT_CLASS = {
  primary: 'btn btn-teal',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger-next',
  plain: 'btn',
} as const

export type ButtonVariant = keyof typeof VARIANT_CLASS

export function Button({ variant = 'plain', disabled, onClick, title, type = 'button', children, 'aria-label': ariaLabel }: {
  variant?: ButtonVariant
  disabled?: boolean
  onClick?: () => void
  title?: string
  'aria-label'?: string
  type?: 'button' | 'submit'
  children: ReactNode
}) {
  return (
    <button type={type} className={VARIANT_CLASS[variant]} disabled={disabled} onClick={onClick} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  )
}
