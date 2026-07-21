import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { Palette } from './Palette'
import { usePaletteStore, type PaletteResult } from './store'

// navigate.ts's real dispatch logic is covered by palette.test.ts (per-kind
// store-API tests); here we only need to know Palette.tsx calls it with the
// right result on Enter/click, so it's mocked.
vi.mock('./navigate', () => ({ openResult: vi.fn() }))
import { openResult } from './navigate'

const RESULTS: PaletteResult[] = [
  { kind: 'session', id: 's1', title: 'Session one', snippet: '', ts: 2 },
  { kind: 'session', id: 's2', title: 'Session two', snippet: '', ts: 1 },
  { kind: 'note', id: 'n1', title: 'Note one', snippet: '', ts: 3 },
]

function resetStore(overrides: Partial<ReturnType<typeof usePaletteStore.getState>> = {}) {
  usePaletteStore.setState({
    open: false,
    query: '',
    results: [],
    selectedIndex: 0,
    loading: false,
    error: null,
    requestGen: 0,
    ...overrides,
  })
}

describe('Palette component', () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
    window.location.hash = ''
    document.body.innerHTML = ''
  })

  it('⌘K opens the palette when closed', () => {
    render(<Palette />)
    expect(usePaletteStore.getState().open).toBe(false)

    act(() => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
    })

    expect(usePaletteStore.getState().open).toBe(true)
  })

  it('Ctrl-K opens the palette too (non-Mac)', () => {
    render(<Palette />)
    act(() => {
      fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    })
    expect(usePaletteStore.getState().open).toBe(true)
  })

  it('⌘K preventDefault beats the browser default and never leaks a "k" into a focused input', () => {
    render(<Palette />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    let captured: KeyboardEvent | null = null
    input.addEventListener('keydown', (e) => { captured = e })

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
    })

    expect(usePaletteStore.getState().open).toBe(true)
    expect(captured).not.toBeNull()
    expect((captured as unknown as KeyboardEvent).defaultPrevented).toBe(true)
    // No character was typed into the input.
    expect(input.value).toBe('')
  })

  it('Esc closes the palette while open', () => {
    resetStore({ open: true })
    render(<Palette />)
    expect(usePaletteStore.getState().open).toBe(true)

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(usePaletteStore.getState().open).toBe(false)
  })

  it('↑/↓ move selection across group boundaries (session group -> note group)', () => {
    resetStore({ open: true, results: RESULTS, selectedIndex: 0 })
    render(<Palette />)

    // Two session items (indices 0,1), then one note item (index 2).
    act(() => { fireEvent.keyDown(document, { key: 'ArrowDown' }) })
    expect(usePaletteStore.getState().selectedIndex).toBe(1)

    // Crossing from the session group into the note group.
    act(() => { fireEvent.keyDown(document, { key: 'ArrowDown' }) })
    expect(usePaletteStore.getState().selectedIndex).toBe(2)

    act(() => { fireEvent.keyDown(document, { key: 'ArrowUp' }) })
    expect(usePaletteStore.getState().selectedIndex).toBe(1)
  })

  it('Enter calls openResult with the selected result and closes the palette', () => {
    resetStore({ open: true, results: RESULTS, selectedIndex: 2 })
    render(<Palette />)

    act(() => { fireEvent.keyDown(document, { key: 'Enter' }) })

    expect(openResult).toHaveBeenCalledWith(RESULTS[2])
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it('renders nothing (no DOM node) while closed', () => {
    resetStore({ open: false })
    const { container } = render(<Palette />)
    expect(container.querySelector('.next-palette-backdrop')).toBeNull()
  })

  it('palette closed = only the one hotkey listener remains (no Esc/arrow leak to background handlers)', () => {
    resetStore({ open: false, results: RESULTS })
    render(<Palette />)

    // With the palette closed, Escape/ArrowDown must be no-ops for palette
    // state — proving the keyboard-nav listener isn't still attached.
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    act(() => { fireEvent.keyDown(document, { key: 'ArrowDown' }) })

    expect(usePaletteStore.getState().open).toBe(false)
    expect(usePaletteStore.getState().selectedIndex).toBe(0)
  })

  it('does not open on ⌘K while a kit/Modal.tsx dialog is already open, avoiding a double Esc-close', () => {
    render(<Palette />)
    const modalBackdrop = document.createElement('div')
    modalBackdrop.className = 'next-modal-backdrop'
    const modal = document.createElement('div')
    modal.className = 'next-modal'
    modalBackdrop.appendChild(modal)
    document.body.appendChild(modalBackdrop)

    act(() => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
    })

    expect(usePaletteStore.getState().open).toBe(false)
  })
})
