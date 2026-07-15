import type { ReactNode } from 'react'
import type { Remote } from '../lib/remote'
import { Skeleton, ErrorState } from './states'

/** THE honesty primitive: components render backend state through this, so
 *  loading/error/data are always explicit and a failure can never be hidden.
 *  While refreshing with stale data available, the stale data stays visible
 *  under a subtle busy marker instead of blanking the surface. */
export function RemoteView<T>({ remote, children, empty, onRetry, isEmpty }: {
  remote: Remote<T>
  children: (data: T) => ReactNode
  /** Rendered when data is ready but empty (per isEmpty, default: empty array). */
  empty?: ReactNode
  onRetry?: () => void
  isEmpty?: (data: T) => boolean
}) {
  switch (remote.status) {
    case 'idle':
      return null
    case 'loading':
      if (remote.stale !== undefined) {
        return <div className="next-refreshing" aria-busy="true">{children(remote.stale)}</div>
      }
      return <Skeleton />
    case 'error':
      // A refresh failure must be explicit — but discarding data the store
      // still holds helps nobody. Error banner on top, stale content dimmed
      // beneath it.
      if (remote.stale !== undefined) {
        return (
          <div>
            <ErrorState error={remote.error} onRetry={onRetry} />
            <div className="next-refreshing" aria-busy="true">{children(remote.stale)}</div>
          </div>
        )
      }
      return <ErrorState error={remote.error} onRetry={onRetry} />
    case 'ready': {
      const emptyCheck = isEmpty ?? ((d: T) => Array.isArray(d) && d.length === 0)
      if (empty !== undefined && emptyCheck(remote.data)) return <>{empty}</>
      return <>{children(remote.data)}</>
    }
  }
}
