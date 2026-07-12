// Task 2.2: kill fake health copy. The mobile chat header + More "Gary" card
// used to hardcode "online" / "online · gateway healthy" regardless of
// reality. This derives a real three-state status from navigator.onLine and
// the task-feed's ONE /api/tasks/stream EventSource (live/task-feed.js) —
// the same connection every progress surface already shares.
//
// deriveHealth() is the pure decision table (exported for node:test);
// currentHealth()/healthDotColor() are the render-time wrappers callers use.

import { connectionState } from './task-feed.js';

export function deriveHealth({ online, feedState }) {
  if (!online) return 'offline';
  if (feedState === 'reconnecting') return 'reconnecting…';
  return 'online'; // 'connected' or 'idle' (stream never booted — no evidence of a problem)
}

const DOT_COLOR = {
  online: 'var(--green)',
  'reconnecting…': 'var(--amber)',
  offline: 'var(--red)',
};

// Parity with the desktop rail (app.js renderRail): green for online. The
// rail has no reconnecting/offline distinction of its own (just green/mut);
// mobile's tri-state adds amber/red on top of that same green.
export function healthDotColor(status) {
  return DOT_COLOR[status] || DOT_COLOR.offline;
}

// navigator.onLine is a real boolean in every browser; under node:test (no
// DOM) Node's minimal built-in `navigator` doesn't define it at all, which
// must not read as "offline" — only an explicit `false` does.
function isOnlineSignal() {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

export function currentHealth() {
  return deriveHealth({ online: isOnlineSignal(), feedState: connectionState() });
}
