// Widget/Shortcut deep links: ?action=new|photo|voice|inbox|search is
// dispatched once at boot to the existing composer/inbox controls, then
// stripped from the URL. Pure mapping (planForAction) is unit-tested;
// applyPlan is the thin DOM shell.
// Spec: docs/superpowers/specs/2026-06-13-ios-homescreen-widgets-design.md
//
// Reload survival: sw-register.js reloads the page when a freshly-deployed
// service worker takes control — which can land seconds after boot, mid-flow,
// on a URL we already stripped. The plan is stashed in sessionStorage before
// the strip and only cleared once applyPlan finishes, so the post-reload boot
// replays an unconsumed action instead of silently eating it.

export const ACTION_PLANS = {
  new:   { newChat: true,  focus: 'input', openAttach: false, openInbox: false },
  photo: { newChat: true,  focus: 'none',  openAttach: true,  openInbox: false },
  // voice: like attach, mic capture can't be auto-started without a user gesture,
  // so this intentionally just lands the user in a fresh chat (empty composer →
  // the mic button is showing) — one tap records. Not incomplete wiring.
  voice: { newChat: true,  focus: 'none',  openAttach: false, openInbox: false },
  inbox: { newChat: false, focus: 'none',  openAttach: false, openInbox: true  },
  search:{ newChat: false, focus: 'none',  openAttach: false, openInbox: false, runSearch: true },
};

// Pure: map an action string to its plan, or null if unrecognized.
export function planForAction(action) {
  if (typeof action !== 'string') return null;
  return ACTION_PLANS[action.toLowerCase()] || null;
}

// ---- pending-plan persistence (pure halves are unit-tested) ----------------
const PENDING_KEY = 'gary.pendingDeeplink';
// A replayed action older than this is stale — don't surprise the user with a
// resurrected autosend minutes after they moved on.
const PENDING_FRESH_MS = 120000;

export function serializePending(plan, now) {
  return JSON.stringify({ plan, ts: now });
}

export function parsePending(raw, now) {
  if (!raw || typeof raw !== 'string') return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (_) { return null; }
  if (!rec || typeof rec !== 'object' || !rec.plan || typeof rec.plan !== 'object') return null;
  if (typeof rec.ts !== 'number' || now - rec.ts > PENDING_FRESH_MS || now < rec.ts) return null;
  return rec.plan;
}

function _storePending(plan) {
  try { sessionStorage.setItem(PENDING_KEY, serializePending(plan, Date.now())); } catch (_) {}
}

function _clearPending() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
}

function _readPending() {
  try { return parsePending(sessionStorage.getItem(PENDING_KEY), Date.now()); } catch (_) { return null; }
}

// Poll for a selector (e.g. #rail-inbox is injected late by inbox.js).
// Resolves the element, or null after `tries` attempts.
function _waitFor(selector, tries = 40, interval = 50) {
  return _waitUntil(() => document.querySelector(selector), tries, interval);
}

// Poll an arbitrary predicate; resolves its first truthy value, or null.
function _waitUntil(pred, tries = 40, interval = 50) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      let found = null;
      try { found = pred(); } catch (_) { /* keep polling */ }
      if (found) return resolve(found);
      if (++n >= tries) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

// Thin DOM shell: drive existing controls per the plan. Best-effort; never
// throws. Clears the pending-plan stash on the way out (finally) — completed
// AND failed runs are consumed; only a reload that kills the page mid-flow
// leaves the stash behind for the replay path in initDeepLinks.
export async function applyPlan(plan) {
  if (!plan) return;
  try {
    if (plan.openInbox) {
      const inbox = (await _waitFor('#rail-inbox'))
        || document.getElementById('inbox-section-title');
      if (inbox) inbox.click();
      return;
    }
    if (plan.runSearch) {
      const input = await _waitFor('input[data-model="convFilter"]');
      if (input) {
        input.value = plan.searchQuery || '';
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (plan.newChat) {
      // Redesign UI: the "New conversation" button carries data-act="newChat".
      // Classic Odysseus UI: fall back to #rail-new-session.
      const newBtn = (await _waitFor('[data-act="newChat"]'))
        || (await _waitFor('#rail-new-session', 4, 50));
      if (newBtn) {
        // The redesign has TWO newChat actions: a weak one from app.js that
        // just clears the draft, and a full reset from live/chat.js that gets
        // merged in async by live/index.js. If we click before the merge, the
        // weak one wins and the previously-active thread stays open. Click
        // once immediately, then again after a beat to catch the strong
        // version once it's registered.
        newBtn.click();
        await new Promise((r) => setTimeout(r, 400));
        try { (document.querySelector('[data-act="newChat"]') || newBtn).click(); } catch (_) {}
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (plan.focus === 'input') {
      // Redesign composer is the [data-model="draft"] textarea; classic UI
      // uses #message. Poll for whichever renders first.
      const input = (await _waitFor('[data-model="draft"], #message'));
      if (input) {
        if (plan.prefill) {
          input.value = plan.prefill;
          // The data-model binder syncs state.draft on input events, so the
          // Send button + slash detection see the prefill.
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        input.focus();
        try {
          const len = input.value.length;
          if (typeof input.setSelectionRange === 'function') input.setSelectionRange(len, len);
        } catch (_) {}
      }
    }
    if (plan.autosend) {
      // Give the composer a beat to settle (autosize, mode detection), then
      // fire the send and VERIFY it took — send() drains state.draft and
      // re-renders, so an emptied composer is the "message accepted" signal.
      // Open-loop click-and-hope raced the still-merging live action map;
      // retry a couple of times before giving up (worst case the prefill just
      // stays in the composer for the user to send by hand).
      await new Promise((r) => setTimeout(r, 120));
      for (let attempt = 0; attempt < 3; attempt++) {
        // Re-query every attempt: render() rebuilds root.innerHTML wholesale,
        // so nodes from the previous attempt may be stale/disconnected.
        const sendBtn = document.querySelector('.btn-send[data-act="send"]');
        const draft = document.querySelector('[data-model="draft"]');
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else if (draft) {
          // Desktop composer sends on plain Enter (Shift+Enter = newline).
          draft.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
          }));
        } else {
          break; // no composer at all — nothing to drive
        }
        const consumed = await _waitUntil(() => {
          const ta = document.querySelector('[data-model="draft"]');
          return !!(ta && ta.value === '');
        }, 10, 100);
        if (consumed) break;
      }
    }
    if (plan.openAttach) {
      // Best-effort: open the attach picker. iOS Safari blocks file-input
      // activation without a user gesture on a fresh load, so this may no-op —
      // by design the user then lands in a new chat with attach one tap away.
      const attach = document.getElementById('overflow-attach-btn');
      if (attach) { try { attach.click(); } catch (_) {} }
    }
  } catch (_) { /* deep-link is best-effort; never block boot */
  } finally {
    _clearPending();
  }
}

// Read ?action=, stash + strip it immediately (clean reload/back), then
// dispatch. A load WITHOUT ?action= replays a fresh unconsumed stash instead —
// that's the service-worker-update reload landing on the already-stripped URL.
export function initDeepLinks() {
  let params;
  try { params = new URLSearchParams(window.location.search); } catch (_) { return; }
  const action = params.get('action');
  let plan = planForAction(action);
  if (plan) {
    // Deliberately mutating the shared ACTION_PLANS entry is avoided: copy.
    plan = { ...plan };
    if (plan.runSearch) plan.searchQuery = params.get('q') || '';
    if (plan.newChat) plan.prefill = params.get('q') || '';
    if (plan.newChat && params.get('autosend') === '1' && plan.prefill) plan.autosend = true;
    // Stash BEFORE the strip: if a reload lands mid-flow the next boot can
    // still see what it was supposed to do. Cleared in applyPlan's finally.
    _storePending(plan);
  } else if (!action) {
    plan = _readPending(); // reload-survival path; null when nothing pending
  }
  if (action) {
    // Strip action + its payload params (even unrecognized ones) so a refresh
    // doesn't replay via URL — the stash owns replay now, freshness-bounded.
    try {
      params.delete('action');
      params.delete('q');
      params.delete('autosend');
      const qs = params.toString();
      const clean = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState(null, '', clean);
    } catch (_) { /* ignore */ }
  }
  if (!plan) return;
  // If we're forcing a new chat, wipe the stored active-session id BEFORE the
  // SPA's load() reads it — otherwise the loader restores the last thread and
  // clobbers the new-chat click that runs a few frames later. (Runs on the
  // replay path too — the post-reload loader does the same restore.)
  if (plan.newChat) {
    try { localStorage.removeItem('redesign.chat.activeId'); } catch (_) {}
  }
  const run = () => applyPlan(plan);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    run();
  } else {
    window.addEventListener('DOMContentLoaded', run, { once: true });
  }
}

// Auto-init only in a real browser (skipped under node unit tests).
if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.location) {
  initDeepLinks();
}
