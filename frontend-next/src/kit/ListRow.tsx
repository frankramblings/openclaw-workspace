import type { ReactNode } from 'react'

export function ListRow({ title, meta, selected, onClick, actions }: {
  title: ReactNode
  meta?: ReactNode
  selected?: boolean
  onClick?: () => void
  actions?: ReactNode
}) {
  return (
    <div
      className={`next-row${selected ? ' is-selected' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
    >
      <div className="next-row-main">
        <div className="next-row-title">{title}</div>
        {meta && <div className="next-row-meta">{meta}</div>}
      </div>
      {actions && <div className="next-row-actions" onClick={(e) => e.stopPropagation()}>{actions}</div>}
    </div>
  )
}

export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="next-section-head">
      <h2 className="next-section-title">{title}</h2>
      {actions && <div className="next-section-actions">{actions}</div>}
    </header>
  )
}
