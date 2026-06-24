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
};
