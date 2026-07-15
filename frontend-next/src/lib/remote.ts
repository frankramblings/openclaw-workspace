// Remote<T>: the honest-state primitive. Every piece of backend-derived UI
// state lives in one of these four shapes — components render the shape, so
// there is no way to display data the backend didn't provide, and no way to
// hide a failure.

export type Remote<T> =
  | { status: 'idle' }
  | { status: 'loading'; stale?: T }
  | { status: 'ready'; data: T; fetchedAt: number }
  | { status: 'error'; error: string; stale?: T }

export const idle = { status: 'idle' } as const

/** Run `fetcher`, publishing loading → ready/error through `set`. A previous
 *  ready value rides along as `stale` so lists don't blank during refresh. */
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
    set(stale === undefined ? { status: 'error', error } : { status: 'error', error, stale })
  }
}
