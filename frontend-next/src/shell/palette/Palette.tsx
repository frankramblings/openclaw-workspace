import { useEffect, useRef } from 'react'
import { usePaletteStore, type PaletteResult } from './store'
import { openResult } from './navigate'
import { useHistoryLayer } from '../useHistoryLayer'
import './palette.css'

/**
 * Shell-level ⌘K palette: grouped search results with keyboard navigation.
 *
 * Keyboard:
 * - ⌘K / Ctrl-K: toggle open
 * - Esc: close (when open)
 * - ↑/↓: navigate selection across groups
 * - Enter: open selected result
 * - Mouse: hover to select, click to open
 */
export function Palette() {
  const {
    open,
    query,
    results,
    selectedIndex,
    loading,
    error,
    setOpen,
    setQuery,
    setSelectedIndex,
  } = usePaletteStore()

  const inputRef = useRef<HTMLInputElement>(null)

  // Same open/close lifecycle discipline as kit/Modal.tsx: a same-route
  // history entry so the OS/PWA back gesture closes the palette instead of
  // navigating the underlying app (this app is iOS-Safari-PWA only, where
  // back-swipe is the primary dismiss gesture).
  const close = useHistoryLayer(open, () => setOpen(false))

  // Focus input when palette opens
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  // Global hotkey listener for ⌘K / Ctrl-K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ⌘K or Ctrl-K
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // Don't stack on top of a kit/Modal.tsx dialog: that modal owns its
        // own Esc handler (via its own modal stack) and isn't aware of the
        // palette, so a shared Esc keypress would close both at once. Since
        // the palette's backdrop covers the screen, nothing can open a new
        // modal while the palette itself is open, so this only needs to
        // guard the open direction.
        if (!open && document.querySelector('.next-modal')) return
        e.preventDefault()
        if (open) close(); else setOpen(true)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, setOpen, close])

  // Keyboard navigation within palette
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(selectedIndex - 1)
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(selectedIndex + 1)
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        if (results[selectedIndex]) {
          openResult(results[selectedIndex])
          close()
        }
        return
      }
    }

    // Use capture to ensure we catch keys before child inputs
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [open, results, selectedIndex, setOpen, setSelectedIndex, close])

  if (!open) return null

  // Group results by kind
  const grouped = groupResults(results)

  return (
    <div className="next-palette-backdrop" onClick={() => close()} role="presentation">
      <div className="next-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="next-palette-input"
          placeholder="Search sessions, notes, documents, email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />

        <div className="next-palette-results">
          {error && <div className="next-palette-error">{error}</div>}

          {loading && <div className="next-palette-loading">Loading…</div>}

          {!loading && !error && results.length === 0 && query && (
            <div className="next-palette-empty">No results found</div>
          )}

          {!loading && !error && results.length === 0 && !query && (
            <div className="next-palette-empty">Start typing to search…</div>
          )}

          {grouped.map((group) => (
            <div key={group.kind} className="next-palette-group">
              <div className="next-palette-group-header">{group.label}</div>
              <div className="next-palette-group-items">
                {group.items.map((result) => {
                  const resultIdx = results.findIndex(r => r.kind === result.kind && r.id === result.id)
                  const isSelected = resultIdx === selectedIndex
                  return (
                    <button
                      key={`${result.kind}-${result.id}`}
                      className={`next-palette-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        const fullResult = results[resultIdx]
                        if (fullResult) {
                          openResult(fullResult)
                          close()
                        }
                      }}
                      onMouseEnter={() => setSelectedIndex(resultIdx)}
                    >
                      <div className="next-palette-item-title">{result.title}</div>
                      {result.snippet && (
                        <div className="next-palette-item-snippet">{result.snippet}</div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

interface GroupedResult {
  kind: 'session' | 'note' | 'document' | 'email'
  label: string
  items: PaletteResult[]
}

function groupResults(results: PaletteResult[]): GroupedResult[] {
  const groups: Record<string, GroupedResult> = {}
  const order = ['session', 'note', 'document', 'email']
  const labels: Record<string, string> = {
    session: 'Chats',
    note: 'Notes',
    document: 'Documents',
    email: 'Email',
  }

  for (const result of results) {
    if (!groups[result.kind]) {
      groups[result.kind] = {
        kind: result.kind,
        label: labels[result.kind] || result.kind,
        items: [],
      }
    }
    groups[result.kind].items.push(result)
  }

  return order
    .filter((k) => groups[k])
    .map((k) => groups[k])
}
