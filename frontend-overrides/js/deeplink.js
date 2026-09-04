import { runtime } from './redesign/live/runtime.js';
import { apiJson } from './redesign/live/api.js';

// Widget/Shortcut deep links: ?action=new|photo|voice|inbox|search is
// dispatched once at boot to the existing composer/inbox controls, then
// stripped from the URL. Pure mapping (planForAction) is unit-tested;
// applyPlan is the thin DOM shell.
// Spec: docs/superpowers/specs/2026-06-13-ios-homescreen-widgets-design.md
//
// runtime.actions: app.js sets `runtime.actions = actions` at boot and
// live/index.js Object.assign()s each live module's actions (chat.js's
// convSearch among them) into that SAME object once its dynamic import
// resolves. That's the only way this standalone module can observe "has the
// live search action merged in yet?" without a direct reference to app.js's
// (unexported) `actions` closure — see applyPlan's runSearch branch.
//
// Redesign-native, not classic-DOM: inbox/photo/search drive the redesign
// shell (location.hash routing, [data-upload], [data-model="convFilter"] +
// its openConvSheet drawer opener). Classic Odysseus UI now lives only at
// /classic (soaking toward retirement) and isn't targeted by these three —
// `new`/`focus`/`voice` keep their classic fallbacks since those already
// worked for both shells.
//
// Reload survival: sw-register.js reloads the page when a freshly-deployed
// service worker takes control — which can land seconds after boot, mid-flow,
// on a URL we already stripped. The plan is stashed in sessionStorage before
// the strip and only cleared once applyPlan finishes, so the post-reload boot
// replays an unconsumed action instead of silently eating it.

// Frozen (table + every entry): nothing legitimately mutates a plan in place —
// initDeepLinks always copies (`{ ...plan }`) before attaching per-request
// fields (see below) — so a stray direct write is a bug, and freezing turns
// it into a loud throw instead of silent cross-request state leakage.
export const ACTION_PLANS = Object.freeze({
  new:   Object.freeze({ newChat: true,  focus: 'input', openAttach: false, openInbox: false }),
  photo: Object.freeze({ newChat: true,  focus: 'none',  openAttach: true,  openInbox: false }),
  // voice: neither shell has a mic/recorder — there's no capture gesture to
  // land on. Same plan as `new`: a fresh, focused chat ready to type into.
  voice: Object.freeze({ newChat: true,  focus: 'input', openAttach: false, openInbox: false }),
  inbox: Object.freeze({ newChat: false, focus: 'none',  openAttach: false, openInbox: true  }),
  search:Object.freeze({ newChat: false, focus: 'none',  openAttach: false, openInbox: false, runSearch: true }),
  // ?action=clip&q=<url>[&mention=1] -- an iOS Shortcut hands off a shared
  // URL. newChat starts false (most clips just open the document); when
  // mention=1 is requested, clipPlanFields flips it to true up front (at
  // parse time, not after the async /api/clip call) so the SAME
  // localStorage.removeItem('redesign.chat.activeId') anti-race guard
  // `new`/`photo`/`voice` already get (below, in initDeepLinks) also
  // covers this action.
  clip:  Object.freeze({ newChat: false, focus: 'none',  openAttach: false, openInbox: false, doClip: true }),
});

// Pure: map an action string to its plan, or null if unrecognized.
export function planForAction(action) {
  if (typeof action !== 'string') return null;
  return ACTION_PLANS[action.toLowerCase()] || null;
}

// Pure: derive the clip deep-link's per-request fields from its query
// params. mention === '1' means "drop the mention token into a fresh
// chat's composer after clipping" -- that implies a fresh chat, so newChat
// is derived HERE (not left for applyPlan's async branch) so
// initDeepLinks' early localStorage.removeItem (which only reads the
// plan's STATIC newChat field, before any network call runs) sees it.
export function clipPlanFields(searchParams) {
  const mentionAfterClip = searchParams.get('mention') === '1';
  return {
    clipUrl: searchParams.get('q') || '',
    mentionAfterClip,
    newChat: mentionAfterClip,
  };
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

// The redesign shell switches desktop/mobile layout at the same breakpoint
// app.js uses for its own `mq` (max-width: 768px) — mirrored here since
// deeplink.js is a standalone module with no access to app.js's internals
// (see the big comment above applyPlan).
function _isMobileLayout() {
  try { return window.matchMedia('(max-width: 768px)').matches; } catch (_) { return false; }
}

// Pure: decide what a single search-dispatch poll tick should do, given the
// live `runtime.actions` object (null/undefined until app.js's boot line
// runs) and how many ticks have elapsed against the budget. 'ready' once
// convSearch has merged in (checked first — a merge landing on the very last
// tick still counts as ready, not give-up), 'give-up' once the attempt
// budget is exhausted without it, 'retry' otherwise.
export function searchDispatchPlan(actionsObj, attempt, maxAttempts) {
  if (actionsObj && typeof actionsObj.convSearch === 'function') return 'ready';
  if (attempt >= maxAttempts) return 'give-up';
  return 'retry';
}

// Pure: `searchString` is a location.search-shaped string (leading '?'
// optional — URLSearchParams tolerates either). Returns it with the
// deep-link params (action/q/autosend/mention) removed and every other param
// preserved, in the same '?k=v&...'-or-'' shape location.search itself uses
// — so callers can splice it straight back into pathname+hash. `mention` is
// clip-only (see ACTION_PLANS.clip / clipPlanFields) but stripped
// unconditionally like the others, same as autosend is stripped even for
// actions that never read it -- a leftover deep-link param in the address
// bar after the redirect is exactly what this strip exists to prevent.
export function cleanedSearch(searchString) {
  const params = new URLSearchParams(searchString || '');
  params.delete('action');
  params.delete('q');
  params.delete('autosend');
  params.delete('mention');
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

// Poll for a selector (e.g. the composer/attach controls, injected late by
// the shell's first render()). Resolves the element, or null after `tries`
// attempts.
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
    if (plan.doClip && plan.clipUrl) {
      // Best-effort clip; never blocks boot. On success, opens the document
      // (or, with mention=1, prefills a fresh chat's composer with the
      // mention token). On failure, see the catch block below for what
      // happens to the URL and the composer -- it depends on mentionAfterClip.
      try {
        const res = await apiJson('/api/clip', { url: plan.clipUrl });
        if (plan.mentionAfterClip) {
          // Fall through to the existing newChat/focus branches below --
          // plan.newChat is already true (set at parse time by
          // clipPlanFields), this just supplies the dynamic prefill they
          // read.
          plan.focus = 'input';
          plan.prefill = (res && res.mention) || '';
        } else {
          // No mention requested: land straight on the clipped document,
          // same as tapping a Library card. runtime.actions.openDoc is
          // merged in asynchronously (see the runSearch/newChat branches'
          // own comments on this exact race) -- poll for it the same way.
          const ready = await _waitUntil(
            () => runtime.actions && typeof runtime.actions.openDoc === 'function',
            40, 125,
          );
          if (ready && res && res.document && res.document.id) {
            try { runtime.actions.openDoc(res.document.id); } catch (_) {}
          }
          return;
        }
      } catch (_) {
        if (plan.mentionAfterClip) {
          // Fresh chat is already forced (newChat=true, set at parse time by
          // clipPlanFields), so the composer that's about to render is
          // guaranteed empty -- same fallback as the success path above,
          // just with the raw URL instead of a mention token.
          plan.focus = 'input';
          plan.prefill = plan.clipUrl;
        } else {
          // No fresh chat here (newChat stayed false) -- the composer about
          // to render is whatever surface the user was already on, and it
          // may hold an unsent draft. Never clobber it: only offer the
          // failed URL back when the composer is empty, and leave
          // focus/surface alone otherwise (skip the shared
          // plan.focus === 'input' block entirely below by not setting it).
          // Toast copy is Task 6's job (clipErrorMessage in
          // redesign/clip-core.js); warn for now so a failed clip is at
          // least visible somewhere.
          console.warn('[clip] deep-link clip failed', plan.clipUrl);
          const input = await _waitFor('[data-model="draft"], #message');
          if (input && input.value.trim() === '') {
            input.value = plan.clipUrl;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            try {
              const len = input.value.length;
              if (typeof input.setSelectionRange === 'function') input.setSelectionRange(len, len);
            } catch (_) {}
          }
        }
      }
    }
    if (plan.openInbox) {
      // The redesign routes surfaces off location.hash — app.js seeds
      // state.surface from it on boot (SURFACES.includes(fromHash)) and also
      // reacts to a live 'hashchange' (mobile's seedMobileFromHash maps
      // #inbox straight onto the bottom-tab "inbox" surface too), so this one
      // assignment covers desktop AND mobile with no DOM to wait for. The old
      // #rail-inbox / #inbox-section-title targets were classic-UI-only
      // (classic now lives at /classic only, being retired) and silently
      // no-opped in the redesign — no DOM fallback is needed here since hash
      // routing isn't missing anything classic-only would have added.
      try { window.location.hash = '#inbox'; } catch (_) {}
      return;
    }
    if (plan.runSearch) {
      if (_isMobileLayout()) {
        // Mobile: the convFilter input lives inside the conversation drawer,
        // which is only reachable (focus/typeable) once opened — the drawer
        // markup is always in the DOM (off-screen + inert) but that's not
        // enough. Open it the same way a tap on the header's "Chats" button
        // would (data-act="openConvSheet"), then fall through to fill it.
        //
        // That opener only exists in the CHAT header markup (mobile/
        // mobile-surfaces.js's mChat()) — if the deep link landed on another
        // mobile surface (e.g. a prior session left #inbox in the URL),
        // there's nothing to click yet. Route to chat first, the same single
        // hash assignment openInbox above uses (SURFACES routing covers both
        // shells with no DOM to wait for); the _waitFor poll below is the
        // "wait a beat" for the header to actually render off that hashchange.
        const hashSurface = (() => { try { return (window.location.hash || '').replace('#', ''); } catch (_) { return ''; } })();
        if (hashSurface && hashSurface !== 'chat') {
          try { window.location.hash = '#chat'; } catch (_) {}
        }
        const opener = await _waitFor('[data-act="openConvSheet"]');
        if (opener) { try { opener.click(); } catch (_) {} }
      }
      let input = await _waitFor('input[data-model="convFilter"]');
      if (input) {
        input.value = plan.searchQuery || '';
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // The live semantic-search action (actions.convSearch, from
        // live/chat.js) merges into app.js's action map asynchronously —
        // live/index.js dynamic-import()s chat.js and Object.assign()s its
        // actions into the SAME object app.js exposed as runtime.actions,
        // which lands at least one microtask after boot (more on a cold
        // cache). Worse on desktop specifically: convFilter isn't in the
        // data-model input handler's render-skip list, so the dispatch
        // above just triggered a SYNCHRONOUS render() that rebuilds
        // root.innerHTML wholesale — the `input` node captured above is
        // ALREADY DETACHED by the time this line runs. A blind re-dispatch
        // on that stale node (the previous fixed 350ms-timer approach) is
        // dead code: the listener still fires, but on a node the live DOM
        // has abandoned, so nothing downstream observes it — search
        // silently degrades to the instant local title filter with no sign
        // anything went wrong. Poll runtime.actions (app.js sets
        // runtime.actions = actions at boot; the Object.assign above
        // mutates that same object in place) and only re-dispatch once
        // convSearch is actually there, against a FRESH node re-queried at
        // dispatch time — same stale-node discipline newChat/autosend below
        // already use. Bounded generously (~5s) since a cold dynamic import
        // can be slow; give up honestly with one last fresh-node dispatch
        // so the title filter (which the input handler always runs
        // regardless of the merge) still reflects the query.
        const maxAttempts = 40; // ~5s at 125ms
        for (let attempt = 0; ; attempt++) {
          const decision = searchDispatchPlan(runtime.actions, attempt, maxAttempts);
          if (decision === 'retry') {
            await new Promise((r) => setTimeout(r, 125));
            continue;
          }
          // 'ready' (convSearch merged) or 'give-up' (timed out — honest
          // title-filter-only fallback): either way, re-query fresh and fire.
          input = document.querySelector('input[data-model="convFilter"]');
          if (input) { try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} }
          break;
        }
      }
      return;
    }
    if (plan.newChat) {
      // Redesign UI: the "New conversation" button carries data-act="newChat".
      // Classic Odysseus UI: fall back to #rail-new-session.
      const newBtn = (await _waitFor('[data-act="newChat"]'))
        || (await _waitFor('#rail-new-session', 4, 50));
      if (newBtn) {
        // The redesign has TWO newChat actions: a minimal pre-merge stub from
        // app.js and the canonical full reset from live/chat.js, merged into
        // the SAME runtime.actions object once its dynamic import resolves.
        // The old workaround clicked twice with a fixed 400ms gap — a race
        // (a slow merge still got the stub twice) and a double reset when the
        // strong action was already there. Do what the runSearch branch above
        // does instead: poll runtime.actions until the live chat module's
        // actions have merged (searchDispatchPlan's convSearch sentinel comes
        // from that same module), then click ONCE against a fresh node. On
        // give-up (~5s, e.g. the dynamic import failed) the single click
        // lands on the stub — which shares the canonical visible shape (chat
        // surface, cleared draft, focused composer), just without the live
        // thread reset the missing module would have done anyway.
        const maxAttempts = 40; // ~5s at 125ms, same budget as runSearch
        for (let attempt = 0; ; attempt++) {
          const decision = searchDispatchPlan(runtime.actions, attempt, maxAttempts);
          if (decision === 'retry') {
            await new Promise((r) => setTimeout(r, 125));
            continue;
          }
          break;
        }
        try { (document.querySelector('[data-act="newChat"]') || newBtn).click(); } catch (_) {}
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
      if (_isMobileLayout()) {
        // Mobile (iOS in particular): Safari blocks file-input activation
        // that isn't inside a synchronous user-gesture handler, and the tap
        // that launched this deep link doesn't count by the time this async
        // flow runs — attempting .click() on the file input here is
        // unreliable at best. Rather than silently no-op, land honestly on
        // the fresh chat (already created above) with the composer focused:
        // attach is one visible tap away instead of a picker that may or may
        // not have opened.
        const input = await _waitFor('[data-model="draft"], #message');
        if (input) { try { input.focus(); } catch (_) {} }
      } else {
        // Desktop has no such gesture restriction — the redesign's attach
        // control is a hidden <input type=file data-upload> (in both the
        // desktop composer toolbar and mobile's round attach button);
        // .click() on the input itself opens the native picker without
        // needing to resolve its wrapping <label>.
        const attach = await _waitFor('[data-upload]');
        if (attach) { try { attach.click(); } catch (_) {} }
      }
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
    if (plan.doClip) Object.assign(plan, clipPlanFields(params));
    // Stash BEFORE the strip: if a reload lands mid-flow the next boot can
    // still see what it was supposed to do. Cleared in applyPlan's finally.
    _storePending(plan);
  } else if (!action) {
    plan = _readPending(); // reload-survival path; null when nothing pending
  }
  if (action) {
    // Strip action + its payload params (even unrecognized ones) so a refresh
    // doesn't replay via URL — the stash owns replay now, freshness-bounded.
    // cleanedSearch is the pure (unit-tested) half of this; other params
    // (e.g. a real query string a bookmarklet added) survive the strip.
    try {
      const clean = window.location.pathname + cleanedSearch(window.location.search) + window.location.hash;
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
