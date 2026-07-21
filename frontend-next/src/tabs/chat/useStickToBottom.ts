import { useEffect, useRef, useState } from 'react'

interface StickToBottomResult {
  pinned: boolean
  jumpToBottom: () => void
}

const PIN_THRESHOLD = 40 // pixels from bottom to consider "pinned"

/**
 * Hook for tracking scroll position and auto-pinning content to the bottom.
 * Returns pinned state and a function to jump to bottom.
 * @param ref Reference to the scrollable container element
 */
export function useStickToBottom(ref: React.RefObject<HTMLElement>): StickToBottomResult {
  const [pinned, setPinned] = useState(true)
  // Mirrors `pinned` for synchronous reads inside the MutationObserver
  // callback (see handleMutation below) — kept separate from the effect's
  // dependency array on purpose, see the comment on the effect.
  const pinnedRef = useRef(pinned)
  const observerRef = useRef<MutationObserver | null>(null)
  const rafIdRef = useRef<number | null>(null)

  const isPinned = (el: HTMLElement): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD
  }

  const applyPinned = (value: boolean) => {
    pinnedRef.current = value
    setPinned(value)
  }

  const jumpToBottom = () => {
    if (ref.current) {
      ref.current.scrollTo({
        top: ref.current.scrollHeight,
        behavior: 'smooth',
      })
      applyPinned(true)
    }
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Track scroll position
    const handleScroll = () => {
      applyPinned(isPinned(el))
    }

    // Handle touch events to unpin immediately on user interaction
    const handleTouchStart = () => {
      applyPinned(false)
    }

    // Monitor content growth - scroll down if pinned. Reads pinnedRef (not
    // the `pinned` state variable) so it always sees the latest value even
    // though this closure is only created once (see the effect's deps).
    const handleMutation = () => {
      // Batch mutations with rAF to avoid thrashing
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
      rafIdRef.current = requestAnimationFrame(() => {
        if (ref.current && pinnedRef.current) {
          // Only auto-scroll if we're pinned
          ref.current.scrollTop = ref.current.scrollHeight
        }
        rafIdRef.current = null
      })
    }

    // Set up observers and listeners
    el.addEventListener('scroll', handleScroll, { passive: true })
    el.addEventListener('touchstart', handleTouchStart, { passive: true })

    // Create MutationObserver for content growth
    observerRef.current = new MutationObserver(handleMutation)
    observerRef.current.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    // Initialize pinned state — ONCE, on mount only (see deps: [ref], not
    // [pinned, ref]). This corrective read matters when mounting onto an
    // existing long thread that isn't already scrolled to bottom.
    //
    // It must NOT re-run every time `pinned` changes, which was the original
    // bug: with `pinned` in the deps, calling jumpToBottom() (which sets
    // pinned=true) re-ran this effect immediately, and this same line
    // re-read the DOM's *actual* scrollTop — which a `behavior: 'smooth'`
    // scroll hasn't reached yet — and flipped pinned straight back to false,
    // silently undoing the explicit jump.
    applyPinned(isPinned(el))

    return () => {
      el.removeEventListener('scroll', handleScroll)
      el.removeEventListener('touchstart', handleTouchStart)
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [ref])

  return { pinned, jumpToBottom }
}
