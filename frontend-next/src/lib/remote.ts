// Remote<T>: the honest-state primitive. Every piece of backend-derived UI
// state lives in one of these four shapes — components render the shape, so
// there is no way to display data the backend didn't provide, and no way to
// hide a failure.
import { ApiError } from '../api/client'

export type Remote<T> =
  | { status: 'idle' }
  | { status: 'loading'; stale?: T }
  | { status: 'ready'; data: T; fetchedAt: number }
  // httpStatus preserved from ApiError so 502/503 (gateway restarting — a
  // known recurring condition on this host) can render distinctly.
  | { status: 'error'; error: string; httpStatus?: number; stale?: T }

export const idle = { status: 'idle' } as const

/** One-shot load: publishes loading → ready/error through `set`. A previous
 *  ready value rides along as `stale` so lists don't blank during refresh.
 *  ⚠ No overlap protection — if loads for the same slice can overlap (user
 *  retriggers, session switches), use makeLoader() instead, or the LAST
 *  COMPLETION wins regardless of which load is newest. */
export async function loadInto<T>(
  fetcher: () => Promise<T>,
  set: (r: Remote<T>) => void,
  prev?: Remote<T>,
): Promise<void> {
  const stale = prev && prev.status === 'ready' ? prev.data
    : prev && (prev.status === 'loading' || prev.status === 'error') ? prev.stale
    : undefined
  set(stale === undefined ? { status: 'loading' } : { status: 'loading', stale })
  try {
    const data = await fetcher()
    set({ status: 'ready', data, fetchedAt: Date.now() })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const httpStatus = e instanceof ApiError ? e.status : undefined
    set({ status: 'error', error, httpStatus, ...(stale === undefined ? {} : { stale }) })
  }
}

/** Overlap-safe loader for a single logical slice: each call supersedes the
 *  previous one, and a superseded load's completion (success OR failure) is
 *  silently discarded instead of clobbering fresher state. One loader per
 *  store slice — this is what tab stores should use. */
export function makeLoader<T>(): (
  fetcher: () => Promise<T>,
  set: (r: Remote<T>) => void,
  prev?: Remote<T>,
) => Promise<void> {
  let epoch = 0
  return (fetcher, set, prev) => {
    const mine = ++epoch
    const guarded = (r: Remote<T>) => {
      if (mine === epoch) set(r)
    }
    return loadInto(fetcher, guarded, prev)
  }
}
