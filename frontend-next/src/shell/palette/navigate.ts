/**
 * Navigation helper for palette results.
 *
 * Opens a palette result in the appropriate tab via the registry mechanism
 * and selects the item via that tab's store.
 *
 * Store selection methods per kind:
 * - session: useChatStore.getState().selectSession(id)
 * - note: useNotesStore.getState().select(note) — requires fetching the note first
 * - document: useDocumentsStore.getState().select(id)
 * - email: useEmailStore.getState().select(uid) — requires discovering email store select
 */

import { useChatStore } from '../../tabs/chat/store'
import { useNotesStore } from '../../tabs/notes/store'
import { useDocumentsStore } from '../../tabs/documents/store'
import type { PaletteResult } from './store'

export function openResult(result: PaletteResult): void {
  const { kind, id } = result

  switch (kind) {
    case 'session':
      // Switch to chat tab and select the session
      window.location.hash = '#/chat'
      // SelectSession is async but we fire and forget
      void useChatStore.getState().selectSession(id)
      break

    case 'note':
      // Switch to notes tab and select the note
      window.location.hash = '#/notes'
      // Need to load notes first if not already loaded, then find and select.
      // IMPORTANT: re-read useNotesStore.getState() AFTER awaiting load() —
      // zustand's getState() returns a point-in-time snapshot, so reusing a
      // snapshot captured before the await would see the pre-load (not-ready)
      // `notes` field even though the store has since updated.
      void (async () => {
        if (useNotesStore.getState().notes.status !== 'ready') {
          await useNotesStore.getState().load(false)
        }
        const freshNotes = useNotesStore.getState().notes
        const note = freshNotes.status === 'ready'
          ? freshNotes.data.notes.find((n) => n.id === id)
          : null
        if (note) {
          useNotesStore.getState().select(note)
        } else {
          console.warn(`Note ${id} not found`)
        }
      })()
      break

    case 'document':
      // Switch to documents tab and select the document
      window.location.hash = '#/documents'
      void useDocumentsStore.getState().select(id)
      break

    case 'email':
      // Switch to email tab and select the email
      // Email store selection is TBD based on the actual store structure
      window.location.hash = '#/email'
      // TODO: Implement email selection once email store is known
      console.warn('Email selection not yet implemented')
      break

    default:
      console.warn(`Unknown palette result kind: ${kind}`)
  }
}
