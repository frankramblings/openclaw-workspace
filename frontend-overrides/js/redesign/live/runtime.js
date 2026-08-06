// Shared runtime handle so live/* modules can read state and request a
// re-render after async work (fetches, stream deltas) completes. app.js
// populates this at boot.

export const runtime = {
  state: null,
  render: () => {},
  // Set by the chat data layer once a thread's content is loaded (open / switch /
  // refresh) to request the next render scroll to the latest message. render()
  // honors it then clears it, so it reliably survives the open's multi-render
  // sequence (the early pre-fetch render can't consume it).
  wantChatBottom: false,
  // "Follow the bottom as new content streams in." LATCHED intent, not a
  // per-frame position guess: flips false the moment the user scrolls up (any
  // amount — trackpad/touch momentum arrives as many small deltas, so a
  // position-only test kept re-pinning them mid-scroll), and flips back true
  // only when they return to the bottom (or tap the jump-to-latest button).
  // While false, the streaming patch never touches scrollTop, so scroll-up
  // during a live turn actually holds. See app.js patchMessage + scroll listener.
  chatFollow: true,
};
