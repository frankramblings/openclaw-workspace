// Skeleton / EmptyState / ErrorState / StubTab — the four honest non-data
// states. Kept in one file: they change together.
import { Button } from './Button'

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="next-skel" role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="next-skel-line" style={{ width: `${88 - (i % 3) * 14}%` }} />
      ))}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="next-empty">
      <p className="next-empty-title">{title}</p>
      {hint && <p className="next-empty-hint">{hint}</p>}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="next-error" role="alert">
      <p className="next-error-title">Couldn't load this</p>
      <p className="next-error-detail">{error}</p>
      {onRetry && <Button variant="plain" onClick={onRetry}>Retry</Button>}
    </div>
  )
}

/** Honest placeholder for tabs not yet built in /next. */
export function StubTab({ tab }: { tab: string }) {
  return (
    <div className="next-empty next-stub">
      <p className="next-empty-title">Not built in /next yet</p>
      <p className="next-empty-hint">
        This surface is coming in the next wave. Until then it lives in the
        current app: <a href={`/#/${tab}`}>open {tab} there</a>.
      </p>
    </div>
  )
}
