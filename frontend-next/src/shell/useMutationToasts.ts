import { useEffect } from 'react'
import type { MutationNotice } from '../api/client'
import { useToasts } from '../kit'

export function useMutationToasts() {
  useEffect(() => {
    const listener = (event: Event) => {
      const notice = (event as CustomEvent<MutationNotice>).detail
      if (!notice) return
      useToasts.getState().push(notice.ok ? notice.message : `Couldn't save: ${notice.message}`, notice.ok ? 'ok' : 'err')
    }
    window.addEventListener('next:mutation', listener)
    return () => window.removeEventListener('next:mutation', listener)
  }, [])
}
