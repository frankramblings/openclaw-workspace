import type { ReactNode } from 'react'

export function Card({ title, actions, children }: {
  title?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="next-card">
      {(title || actions) && (
        <header className="next-card-head">
          {title && <h3 className="next-card-title">{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}
