// Hash routes for the shell. Two shapes: '#<surface>' and '#chat/<sessionId>'.
// Pure: no DOM, no location access. app.js and live/chat.js call these.

export const SURFACES = ['chat', 'inbox', 'email', 'calendar', 'research', 'library', 'notes', 'settings'];
const MOBILE_SPECIAL = ['more', 'capture'];
// Session ids are 12 hex chars from the backend; accept a slightly wider
// charset so a future id format does not break routing, but never markup.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  const none = { surface: null, sessionId: null, special: null };
  if (!h) return none;
  const slash = h.indexOf('/');
  const head = slash === -1 ? h : h.slice(0, slash);
  const rest = slash === -1 ? '' : h.slice(slash + 1);
  if (head === 'chat') {
    return { surface: 'chat', sessionId: ID_RE.test(rest) ? rest : null, special: null };
  }
  if (SURFACES.includes(head)) return { surface: head, sessionId: null, special: null };
  if (MOBILE_SPECIAL.includes(head)) return { surface: null, sessionId: null, special: head };
  return none;
}

export function chatHash(id) {
  return id ? `#chat/${id}` : '#chat';
}

// After any popstate on the chat surface: a history entry can never
// legitimately name a different thread than the one on screen, because thread
// hashes are written with replaceState only (live/chat.js _setHash). The
// mobile UI ladder (app.js syncMobileHistory) pushes and pops entries whose
// URLs froze the hash of the moment they were pushed, so a pop can surface a
// stale thread id. Returns the hash the shell must re-assert, or null.
export function reassertedThreadHash(hash, activeId) {
  if (!activeId) return null;
  const p = parseHash(hash);
  if (p.surface !== 'chat') return null;
  return p.sessionId === activeId ? null : chatHash(activeId);
}
