import { create } from 'zustand'
import { apiGet } from '../../api/client'

export interface PaletteResult {
  kind: 'session' | 'note' | 'document' | 'email'
  id: string
  title: string
  snippet: string
  ts: number | null
}

interface PaletteState {
  open: boolean
  query: string
  results: PaletteResult[]
  selectedIndex: number
  loading: boolean
  error: string | null
  requestGen: number
  // Actions
  setOpen(open: boolean): void
  setQuery(q: string): void
  setSelectedIndex(idx: number): void
  search(q: string): Promise<void>
  mergeWithSemantic(paletteResults: PaletteResult[], semanticResults: PaletteResult[]): PaletteResult[]
}

// Debounce configuration
const DEBOUNCE_MS = 200

let debounceTimer: ReturnType<typeof setTimeout> | null = null

export const usePaletteStore = create<PaletteState>((set, get) => ({
  open: false,
  query: '',
  results: [],
  selectedIndex: 0,
  loading: false,
  error: null,
  requestGen: 0,

  setOpen: (open: boolean) => {
    set({ open })
    if (!open) {
      set({ query: '', results: [], selectedIndex: 0, error: null })
    }
  },

  setQuery: (q: string) => {
    set({ query: q, selectedIndex: 0 })
    // Cancel previous debounce
    if (debounceTimer) clearTimeout(debounceTimer)
    // Debounce the search
    debounceTimer = setTimeout(() => {
      void get().search(q)
    }, DEBOUNCE_MS)
  },

  setSelectedIndex: (idx: number) => {
    const { results } = get()
    const clamped = Math.max(0, Math.min(idx, results.length - 1))
    set({ selectedIndex: clamped })
  },

  mergeWithSemantic: (paletteResults: PaletteResult[], semanticResults: PaletteResult[]): PaletteResult[] => {
    // Create a Set of session IDs from palette results for deduping
    const paletteSessionIds = new Set<string>()
    const mergedResults: PaletteResult[] = []

    // Add all palette results
    for (const r of paletteResults) {
      mergedResults.push(r)
      if (r.kind === 'session') {
        paletteSessionIds.add(r.id)
      }
    }

    // Add semantic results that aren't already in palette (dedupe by session id)
    for (const r of semanticResults) {
      if (r.kind === 'session' && paletteSessionIds.has(r.id)) {
        continue // Skip duplicates
      }
      mergedResults.push(r)
    }

    return mergedResults
  },

  search: async (q: string) => {
    const { requestGen, mergeWithSemantic } = get()
    const currentGen = requestGen + 1
    set({ requestGen: currentGen, loading: true, error: null })

    try {
      // Fetch from both endpoints in parallel
      const [paletteResp, semanticResp] = await Promise.allSettled([
        apiGet(`/api/palette?q=${encodeURIComponent(q)}&limit=100`) as Promise<{ results: PaletteResult[] }>,
        apiGet(`/api/search?q=${encodeURIComponent(q)}&limit=100`) as Promise<{ results: PaletteResult[] }>,
      ])

      // Check if this is still the current request
      if (get().requestGen !== currentGen) {
        return // Stale response, discard
      }

      const paletteResults = paletteResp.status === 'fulfilled' ? paletteResp.value.results : []
      const semanticResults = semanticResp.status === 'fulfilled' ? semanticResp.value.results : []

      const merged = mergeWithSemantic(paletteResults, semanticResults)
      set({ results: merged, loading: false })
    } catch (error) {
      if (get().requestGen !== currentGen) return // Stale response
      set({
        error: error instanceof Error ? error.message : 'Search failed',
        loading: false,
        results: [],
      })
    }
  },
}))
