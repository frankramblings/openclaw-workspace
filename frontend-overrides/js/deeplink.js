// Widget/Shortcut deep links: ?action=new|photo|voice|inbox is dispatched once
// at boot to the existing composer/inbox controls, then stripped from the URL.
// Pure mapping (planForAction) is unit-tested; applyPlan is the thin DOM shell.
// Spec: docs/superpowers/specs/2026-06-13-ios-homescreen-widgets-design.md

export const ACTION_PLANS = {
  new:   { newChat: true,  focus: 'input', openAttach: false, openInbox: false },
  photo: { newChat: true,  focus: 'none',  openAttach: true,  openInbox: false },
  voice: { newChat: true,  focus: 'none',  openAttach: false, openInbox: false },
  inbox: { newChat: false, focus: 'none',  openAttach: false, openInbox: true  },
};

// Pure: map an action string to its plan, or null if unrecognized.
export function planForAction(action) {
  if (typeof action !== 'string') return null;
  return ACTION_PLANS[action.toLowerCase()] || null;
}

// Poll for a selector (e.g. #rail-inbox is injected late by inbox.js).
// Resolves the element, or null after `tries` attempts.
function _waitFor(selector, tries = 40, interval = 50) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      if (++n >= tries) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

// Thin DOM shell: drive existing controls per the plan. Best-effort; never throws.
export async function applyPlan(plan) {
  if (!plan) return;
  try {
    if (plan.openInbox) {
      const inbox = (await _waitFor('#rail-inbox'))
        || document.getElementById('inbox-section-title');
      if (inbox) inbox.click();
      return;
    }
    if (plan.newChat) {
      const railNew = await _waitFor('#rail-new-session');
      if (railNew) railNew.click();
      // Let the new chat render before touching composer controls.
      await new Promise((r) => setTimeout(r, 150));
    }
    if (plan.focus === 'input') {
      const input = document.getElementById('message');
      if (input) input.focus();
    }
    if (plan.openAttach) {
      // Best-effort: open the attach picker. iOS Safari blocks file-input
      // activation without a user gesture on a fresh load, so this may no-op —
      // by design the user then lands in a new chat with attach one tap away.
      const attach = document.getElementById('overflow-attach-btn');
      if (attach) { try { attach.click(); } catch (_) {} }
    }
  } catch (_) { /* deep-link is best-effort; never block boot */ }
}

// Read ?action=, strip it immediately (clean reload/back), then dispatch.
export function initDeepLinks() {
  let params;
  try { params = new URLSearchParams(window.location.search); } catch (_) { return; }
  const action = params.get('action');
  if (!action) return;
  const plan = planForAction(action);
  // Strip the param regardless, so a refresh doesn't replay the action.
  try {
    params.delete('action');
    const qs = params.toString();
    const clean = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    window.history.replaceState(null, '', clean);
  } catch (_) { /* ignore */ }
  if (!plan) return;
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    applyPlan(plan);
  } else {
    window.addEventListener('DOMContentLoaded', () => applyPlan(plan), { once: true });
  }
}

// Auto-init only in a real browser (skipped under node unit tests).
if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.location) {
  initDeepLinks();
}
