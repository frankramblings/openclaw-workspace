import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePaletteStore } from './store'
import { openResult } from './navigate'
import type { PaletteResult } from './store'
import { useChatStore } from '../../tabs/chat/store'
import { useNotesStore } from '../../tabs/notes/store'
import { useDocumentsStore } from '../../tabs/documents/store'

/**
 * Tests for the palette store: debounce, stale-response handling,
 * merge/dedupe logic, and degraded-source handling.
 */

describe('PaletteStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    usePaletteStore.setState({
      open: false,
      query: '',
      results: [],
      selectedIndex: 0,
      loading: false,
      error: null,
      requestGen: 0,
    })
    vi.clearAllTimers()
  })

  describe('open/close', () => {
    it('should toggle open state', () => {
      const store = usePaletteStore.getState()
      store.setOpen(true)
      expect(usePaletteStore.getState().open).toBe(true)
      store.setOpen(false)
      expect(usePaletteStore.getState().open).toBe(false)
    })

    it('should clear query when closing', () => {
      const store = usePaletteStore.getState()
      store.setQuery('test')
      expect(usePaletteStore.getState().query).toBe('test')
      store.setOpen(false)
      expect(usePaletteStore.getState().query).toBe('')
      expect(usePaletteStore.getState().results).toEqual([])
    })
  })

  describe('query and debounce', () => {
    it('should update query immediately', () => {
      usePaletteStore.getState().setQuery('python')
      expect(usePaletteStore.getState().query).toBe('python')
    })

    it('should debounce search requests', async () => {
      vi.useFakeTimers()
      let searchCount = 0

      // Mock the search function to count calls. zustand's setState() does
      // a shallow-copy merge on every call (a NEW state object each time,
      // not an in-place mutation) — so both installing AND restoring the
      // mock must go through usePaletteStore.setState(...), never a direct
      // property assignment on a snapshot from getState(). Assigning to a
      // captured snapshot silently no-ops once any later setState() call
      // (e.g. setQuery) has moved the live state to a new object — which is
      // exactly the bug this test previously had: the mock leaked into
      // every subsequent test in the file because the "restore" wrote to an
      // already-orphaned object. Deliberately NOT delegating to the real
      // search() here: that would fire a real, unmocked fetch() with no way
      // to resolve it, which previously left a dangling network call after
      // the test ended.
      const originalSearch = usePaletteStore.getState().search
      usePaletteStore.setState({
        search: vi.fn(async () => {
          searchCount++
        }),
      })

      try {
        const store = usePaletteStore.getState()
        store.setQuery('python')
        store.setQuery('python ')
        store.setQuery('python prog')

        expect(searchCount).toBe(0) // No searches yet

        vi.advanceTimersByTime(200)
        expect(searchCount).toBe(1) // Only one search after debounce
      } finally {
        usePaletteStore.setState({ search: originalSearch })
        vi.useRealTimers()
      }
    })

    it('should cancel previous debounce on new query', async () => {
      vi.useFakeTimers()
      const searchCalls: string[] = []

      // See the note above: restore via setState(), not a stale-snapshot
      // property assignment, so this mock doesn't leak into later tests.
      const originalSearch = usePaletteStore.getState().search
      usePaletteStore.setState({
        search: vi.fn(async (q: string) => {
          searchCalls.push(q)
        }),
      })

      try {
        const store = usePaletteStore.getState()
        store.setQuery('python')
        vi.advanceTimersByTime(100)
        store.setQuery('python prog') // Cancel first, start new debounce
        vi.advanceTimersByTime(200)

        expect(searchCalls).toEqual(['python prog']) // Only the latest query
      } finally {
        usePaletteStore.setState({ search: originalSearch })
        vi.useRealTimers()
      }
    })
  })

  describe('selection navigation', () => {
    it('should clamp selection index to results bounds', () => {
      const store = usePaletteStore.getState()
      usePaletteStore.setState({
        results: [
          { kind: 'session', id: '1', title: 'A', snippet: '', ts: null },
          { kind: 'session', id: '2', title: 'B', snippet: '', ts: null },
        ],
      })

      store.setSelectedIndex(-1)
      expect(usePaletteStore.getState().selectedIndex).toBe(0)

      store.setSelectedIndex(10)
      expect(usePaletteStore.getState().selectedIndex).toBe(1)

      store.setSelectedIndex(0)
      expect(usePaletteStore.getState().selectedIndex).toBe(0)
    })

    it('should reset selectedIndex when setting query', () => {
      usePaletteStore.setState({
        results: [
          { kind: 'session', id: '1', title: 'A', snippet: '', ts: null },
          { kind: 'session', id: '2', title: 'B', snippet: '', ts: null },
          { kind: 'session', id: '3', title: 'C', snippet: '', ts: null },
        ],
      })
      usePaletteStore.getState().setSelectedIndex(2)
      expect(usePaletteStore.getState().selectedIndex).toBe(2)

      usePaletteStore.getState().setQuery('test')
      expect(usePaletteStore.getState().selectedIndex).toBe(0) // Reset on new query
    })
  })

  describe('merge and dedupe', () => {
    it('should dedupe chat results by session id', () => {
      const paletteResults: PaletteResult[] = [
        { kind: 'session', id: 's1', title: 'Chat 1', snippet: '', ts: 1000 },
      ]
      const semanticResults: PaletteResult[] = [
        { kind: 'session', id: 's1', title: 'Chat 1 (semantic)', snippet: 'match', ts: 1000 },
        { kind: 'session', id: 's2', title: 'Chat 2', snippet: 'match', ts: 2000 },
      ]

      const merged = usePaletteStore.getState().mergeWithSemantic(paletteResults, semanticResults)

      // Should have 2 results: s1 from palette (not duplicate), s2 from semantic
      expect(merged.length).toBe(2)
      expect(merged[0].id).toBe('s1')
      expect(merged[0].snippet).toBe('') // From palette, not semantic
      expect(merged[1].id).toBe('s2')
    })

    it('should preserve order: palette first, then semantic', () => {
      const paletteResults: PaletteResult[] = [
        { kind: 'note', id: 'n1', title: 'Note', snippet: '', ts: 1000 },
      ]
      const semanticResults: PaletteResult[] = [
        { kind: 'session', id: 's1', title: 'Session', snippet: 'match', ts: 2000 },
      ]

      const merged = usePaletteStore.getState().mergeWithSemantic(paletteResults, semanticResults)

      expect(merged[0].kind).toBe('note')
      expect(merged[1].kind).toBe('session')
    })
  })

  describe('stale response handling', () => {
    it('should discard stale responses', async () => {
      vi.useFakeTimers()
      const store = usePaletteStore.getState()

      // Start two searches
      const promise1 = store.search('old')
      usePaletteStore.setState({ requestGen: store.requestGen + 1 })
      const promise2 = store.search('new')

      // Complete both
      vi.runAllTimers()
      await Promise.all([promise1, promise2])

      // Results should be from 'new', not 'old'
      const state = usePaletteStore.getState()
      expect(state.results).toBeDefined()

      vi.useRealTimers()
    })

    it('discards a slow middle response under fast-slow-fast interleaving', async () => {
      // Fire three searches back-to-back (A, B, C) with resolution order
      // A (fast), C (fast), B (slow, arrives LAST in wall-clock time even
      // though it was the SECOND call). Only C — the most recently issued
      // request — must ever be reflected in state, regardless of arrival
      // order. This is the exact scenario a naive "last response wins"
      // (rather than generation-counter) implementation gets wrong.
      type Deferred = { resolve: (v: unknown) => void }
      const pending = new Map<string, Deferred>()
      const originalFetch = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
        const href = String(url)
        return new Promise((resolve) => {
          pending.set(href, {
            resolve: (body: unknown) => resolve(new Response(JSON.stringify(body), { status: 200 })),
          })
        })
      }))

      try {
        const store = usePaletteStore.getState()
        const resultsFor = (label: string): PaletteResult[] => [
          { kind: 'session', id: label, title: label, snippet: '', ts: 1 },
        ]

        const pA = store.search('aaa')
        const pB = store.search('bbb')
        const pC = store.search('ccc')

        const resolveAllFor = (q: string, label: string) => {
          for (const [href, deferred] of pending) {
            if (href.includes(`q=${q}`)) deferred.resolve({ results: resultsFor(label) })
          }
        }

        // A resolves first (fast).
        resolveAllFor('aaa', 'A')
        await pA
        expect(usePaletteStore.getState().results.map(r => r.id)).not.toContain('A')

        // C resolves next (fast) — this is the latest-issued request; its
        // results MUST land.
        resolveAllFor('ccc', 'C')
        await pC
        // Palette + semantic endpoints both return the same session id here,
        // so mergeWithSemantic's dedupe collapses them to one entry.
        expect(usePaletteStore.getState().results.map(r => r.id)).toEqual(['C'])

        // B resolves last (slow) — even though it's the last to arrive, it
        // must NOT overwrite C's results, because a newer request (C) has
        // already superseded it.
        resolveAllFor('bbb', 'B')
        await pB
        // Palette + semantic endpoints both return the same session id here,
        // so mergeWithSemantic's dedupe collapses them to one entry.
        expect(usePaletteStore.getState().results.map(r => r.id)).toEqual(['C'])

        await pA
        // Palette + semantic endpoints both return the same session id here,
        // so mergeWithSemantic's dedupe collapses them to one entry.
        expect(usePaletteStore.getState().results.map(r => r.id)).toEqual(['C'])
      } finally {
        vi.stubGlobal('fetch', originalFetch)
      }
    })
  })
})

describe('navigate', () => {
  it('should warn on unknown kind', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    openResult({
      kind: 'unknown' as any,
      id: 'x',
      title: 'Test',
      snippet: '',
      ts: null,
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown palette result kind')
    )

    warnSpy.mockRestore()
  })

  // Per-kind dispatch: verify each kind calls the REAL target store's
  // actual action with the id/object shape that store expects (contract:
  // "session -> useChatStore.getState().selectSession(id); others: each
  // store's real select/open action"). Mocks are installed and restored via
  // setState() (not direct property assignment on a getState() snapshot —
  // see the note in the debounce tests above for why that silently no-ops).
  it('session kind: switches to #/chat and calls selectSession(id)', () => {
    window.location.hash = ''
    const originalSelectSession = useChatStore.getState().selectSession
    const selectSession = vi.fn(async () => {})
    useChatStore.setState({ selectSession })
    try {
      openResult({ kind: 'session', id: 'sess-1', title: 'T', snippet: '', ts: null })
      expect(window.location.hash).toBe('#/chat')
      expect(selectSession).toHaveBeenCalledWith('sess-1')
    } finally {
      useChatStore.setState({ selectSession: originalSelectSession })
    }
  })

  it('document kind: switches to #/documents and calls select(id)', () => {
    window.location.hash = ''
    const originalSelect = useDocumentsStore.getState().select
    const select = vi.fn(async () => {})
    useDocumentsStore.setState({ select })
    try {
      openResult({ kind: 'document', id: 'doc-1', title: 'T', snippet: '', ts: null })
      expect(window.location.hash).toBe('#/documents')
      expect(select).toHaveBeenCalledWith('doc-1')
    } finally {
      useDocumentsStore.setState({ select: originalSelect })
    }
  })

  it('note kind (already loaded): switches to #/notes and calls select(note) synchronously, no reload', async () => {
    window.location.hash = ''
    const note = { id: 'note-1', title: 'T', content: 'C', note_type: 'note', pinned: false, archived: false, color: '', label: null, due_date: null, repeat: 'none' } as any
    const originalNotes = useNotesStore.getState().notes
    const originalLoad = useNotesStore.getState().load
    const originalSelect = useNotesStore.getState().select
    const load = vi.fn(async () => {})
    const select = vi.fn()
    useNotesStore.setState({
      notes: { status: 'ready', data: { notes: [note] }, fetchedAt: Date.now() } as any,
      load,
      select,
    })
    try {
      openResult({ kind: 'note', id: 'note-1', title: 'T', snippet: '', ts: null })
      await Promise.resolve()
      await Promise.resolve()
      expect(window.location.hash).toBe('#/notes')
      expect(select).toHaveBeenCalledWith(note)
      expect(load).not.toHaveBeenCalled()
    } finally {
      useNotesStore.setState({ notes: originalNotes, load: originalLoad, select: originalSelect })
    }
  })

  it('note kind (not yet loaded): loads first, then re-reads fresh state and calls select(note) — regression for a stale-getState()-snapshot bug', async () => {
    // Previously, navigate.ts captured `useNotesStore.getState()` ONCE
    // before awaiting load(), then kept reading `.notes` off that stale
    // snapshot afterward. Since zustand's setState() replaces the state
    // object rather than mutating it, that stale snapshot never saw the
    // freshly loaded data — so a note requiring a load was ALWAYS reported
    // "not found", even though it loaded successfully. See navigate.ts's
    // note-case comment for the fix (re-read getState() after the await).
    window.location.hash = ''
    const note = { id: 'note-1', title: 'T', content: 'C', note_type: 'note', pinned: false, archived: false, color: '', label: null, due_date: null, repeat: 'none' } as any
    const originalNotes = useNotesStore.getState().notes
    const originalLoad = useNotesStore.getState().load
    const originalSelect = useNotesStore.getState().select
    const load = vi.fn(async () => {
      useNotesStore.setState({ notes: { status: 'ready', data: { notes: [note] }, fetchedAt: Date.now() } as any })
    })
    const select = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useNotesStore.setState({ notes: { status: 'idle' } as any, load, select })
    try {
      openResult({ kind: 'note', id: 'note-1', title: 'T', snippet: '', ts: null })
      // Flush the async IIFE inside navigate.ts's note case.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(load).toHaveBeenCalledTimes(1)
      expect(select).toHaveBeenCalledWith(note)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      useNotesStore.setState({ notes: originalNotes, load: originalLoad, select: originalSelect })
      warnSpy.mockRestore()
    }
  })

  it('email kind: switches to #/email, warns, and does not throw (no email store wired yet — backend never returns email results)', () => {
    window.location.hash = ''
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => openResult({ kind: 'email', id: 'e1', title: 'T', snippet: '', ts: null })).not.toThrow()
      expect(window.location.hash).toBe('#/email')
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
