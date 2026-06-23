// Shared runtime handle so live/* modules can read state and request a
// re-render after async work (fetches, stream deltas) completes. app.js
// populates this at boot.

export const runtime = {
  state: null,
  render: () => {},
};
