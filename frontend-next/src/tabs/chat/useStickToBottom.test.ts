import { test, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStickToBottom } from './useStickToBottom'

test('useStickToBottom returns pinned and jumpToBottom', () => {
  const ref = { current: null }
  const { result } = renderHook(() => useStickToBottom(ref as any))

  expect(result.current).toHaveProperty('pinned')
  expect(result.current).toHaveProperty('jumpToBottom')
  expect(typeof result.current.jumpToBottom).toBe('function')
})

test('useStickToBottom detects pinned state correctly', () => {
  const element = document.createElement('div')
  Object.defineProperty(element, 'scrollHeight', { value: 1000 })
  Object.defineProperty(element, 'clientHeight', { value: 500 })
  Object.defineProperty(element, 'scrollTop', { value: 460, writable: true })

  const ref = { current: element }
  const { result } = renderHook(() => useStickToBottom(ref as any))

  // scrollHeight - scrollTop - clientHeight = 1000 - 460 - 500 = 40 (exactly at threshold, should be pinned)
  expect(result.current.pinned).toBe(true)
})

test('useStickToBottom detects unpinned state on scroll up', () => {
  const element = document.createElement('div')
  Object.defineProperty(element, 'scrollHeight', { value: 1000 })
  Object.defineProperty(element, 'clientHeight', { value: 500 })
  Object.defineProperty(element, 'scrollTop', { value: 300, writable: true })
  Object.defineProperty(element, 'scrollTo', { value: vi.fn() })

  const ref = { current: element }
  const { result } = renderHook(() => useStickToBottom(ref as any))

  // scrollHeight - scrollTop - clientHeight = 1000 - 300 - 500 = 200 (well above threshold)
  expect(result.current.pinned).toBe(false)
})

test('jumpToBottom calls scrollTo with smooth behavior', () => {
  const scrollTo = vi.fn()
  const element = document.createElement('div')
  Object.defineProperty(element, 'scrollHeight', { value: 1000 })
  Object.defineProperty(element, 'clientHeight', { value: 500 })
  Object.defineProperty(element, 'scrollTop', { value: 300, writable: true })
  Object.defineProperty(element, 'scrollTo', { value: scrollTo })

  const ref = { current: element }
  const { result } = renderHook(() => useStickToBottom(ref as any))

  act(() => {
    result.current.jumpToBottom()
  })

  expect(scrollTo).toHaveBeenCalledWith({
    top: 1000,
    behavior: 'smooth',
  })
})

test('useStickToBottom handles scroll events to track pinned state', () => {
  const element = document.createElement('div')
  Object.defineProperty(element, 'scrollHeight', { value: 1000 })
  Object.defineProperty(element, 'clientHeight', { value: 500 })
  Object.defineProperty(element, 'scrollTop', { value: 460, writable: true })
  Object.defineProperty(element, 'scrollTo', { value: vi.fn() })

  const ref = { current: element }
  const { result } = renderHook(() => useStickToBottom(ref as any))

  // Start pinned
  expect(result.current.pinned).toBe(true)

  // Simulate scroll up by changing scrollTop
  act(() => {
    Object.defineProperty(element, 'scrollTop', { value: 300, writable: true })
    const scrollEvent = new Event('scroll', { bubbles: true })
    element.dispatchEvent(scrollEvent)
  })

  // Should be unpinned after scroll up
  expect(result.current.pinned).toBe(false)
})

test('useStickToBottom cleans up listeners on unmount', () => {
  const removeEventListener = vi.fn()
  const element = document.createElement('div')
  Object.defineProperty(element, 'removeEventListener', { value: removeEventListener })
  Object.defineProperty(element, 'scrollHeight', { value: 1000 })
  Object.defineProperty(element, 'clientHeight', { value: 500 })
  Object.defineProperty(element, 'addEventListener', { value: vi.fn() })

  const ref = { current: element }
  const { unmount } = renderHook(() => useStickToBottom(ref as any))

  unmount()

  // removeEventListener should have been called for both scroll and touchstart
  expect(removeEventListener.mock.calls.length).toBeGreaterThanOrEqual(2)
})

test('jumpToBottom re-pins and the pin state is not silently reverted by the effect re-sync', async () => {
  // Regression test: `scrollTo` here mirrors a real `behavior: "smooth"`
  // scroll, which does not update scrollTop instantly — element.scrollTop
  // stays "stale" at 300 for a beat. Before the fix, the effect's mount-time
  // `setPinned(isPinned(el))` re-ran on every pinned change (deps included
  // `pinned`), so it fired right after jumpToBottom's setPinned(true), read
  // the still-stale scrollTop, and flipped pinned back to false.
  const element = document.createElement('div')
  Object.defineProperty(element, 'scrollHeight', { value: 1000 })
  Object.defineProperty(element, 'clientHeight', { value: 500 })
  Object.defineProperty(element, 'scrollTop', { value: 300, writable: true })
  Object.defineProperty(element, 'scrollTo', { value: vi.fn() })

  const ref = { current: element }
  const { result, rerender } = renderHook(() => useStickToBottom(ref as any))
  expect(result.current.pinned).toBe(false)

  await act(async () => {
    result.current.jumpToBottom()
    await Promise.resolve()
  })
  rerender()

  expect(result.current.pinned).toBe(true)
})

test('MutationObserver: content growth while pinned auto-scrolls the container to the new bottom', async () => {
  const element = document.createElement('div')
  Object.defineProperty(element, 'scrollHeight', { value: 1000, writable: true, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: 500 })
  Object.defineProperty(element, 'scrollTop', { value: 970, writable: true }) // within PIN_THRESHOLD (40px)

  const ref = { current: element }
  renderHook(() => useStickToBottom(ref as any))

  element.appendChild(document.createElement('span'))
  Object.defineProperty(element, 'scrollHeight', { value: 1200, writable: true, configurable: true })

  await new Promise((resolve) => setTimeout(resolve, 50)) // MutationObserver delivery + rAF are both async
  expect(element.scrollTop).toBe(1200)
})

test('MutationObserver: content growth while unpinned does NOT move the viewport', async () => {
  const element = document.createElement('div')
  Object.defineProperty(element, 'scrollHeight', { value: 1000, writable: true, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: 500 })
  Object.defineProperty(element, 'scrollTop', { value: 300, writable: true }) // well above threshold, unpinned

  const ref = { current: element }
  renderHook(() => useStickToBottom(ref as any))

  element.appendChild(document.createElement('span'))
  Object.defineProperty(element, 'scrollHeight', { value: 1200, writable: true, configurable: true })

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(element.scrollTop).toBe(300) // never programmatically scrolled
})
