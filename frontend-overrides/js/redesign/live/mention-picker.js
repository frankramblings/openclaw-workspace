// Direct-DOM @-mention picker for the composer (desktop `draft` and mobile
// `mdraft`) -- mirrors live/chat.js's paintGhost (insertAdjacentHTML, no
// runtime.render()) so it works on the mobile composer, which never
// re-renders on keystroke (app.js:1181, `if (fk === 'mdraft') return;`).
// Boots itself on import, the same self-boot convention live/jobs.js uses
// for its overlay (a readyState-guarded DOMContentLoaded listener rather
// than an explicit init call from companion.js/app.js's boot sequence,
// since this widget must be live for every chat surface, not just the
// companion).
import { apiGet } from './api.js';
import { runtime } from './runtime.js';
import { mentionTokenAtCaret, shouldClose, insertMention, renderPickerHtml }
  from '../mention-core.js';

const DEBOUNCE_MS = 120;
const LIMIT = 8;

// Fix round 1, Important 3: a failed /api/palette request must not paint the
// same "No matches" copy a genuinely empty search produces -- that reads as
// a false negative (nothing here) instead of what actually happened (the
// search itself failed). Handled entirely in this widget, not Task 4's
// mention-core.js -- renderPickerHtml's contract (and its tests) for the
// normal item/empty cases is unchanged. No em dash in the copy.
const ERROR_HTML = '<div class="mention-menu"><div class="mention-empty">Could not search notes</div></div>';

let open = null;        // { start, ta, query, items, highlighted, error, el } | null
let debounceTimer = null;
let fetchToken = 0;      // staleness guard: only the newest debounced fetch may paint

function composerField(ta) {
  return ta.getAttribute('data-focus') === 'mdraft' ? 'mdraft' : 'draft';
}

// Fix round 1, Important 2 + Minor 2: closeMenu used to re-find the node via
// a global `document.querySelector('.mention-menu')` -- scoped to nothing in
// particular, and wrong the moment two composers could each have painted one
// (or just fragile in general). paintMenu now stashes the exact node it
// created on `open.el`, so closing is a direct, unambiguous removal of THAT
// node -- no query, no reliance on "only one .mention-menu ever exists".
function closeMenu() {
  const el = open && open.el;
  open = null;
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// Fix round 1, Important 2: true once something has actually been painted
// (open.el set) but that exact node is no longer attached -- a background
// render() (SSE tick, poll) rebuilds root.innerHTML wholesale (app.js
// render()), discarding the old composer subtree including the
// manually-inserted `.mention-menu` this widget owns outside the render
// loop. Before the first paint (still waiting on the debounced fetch),
// `open.el` is unset -- that's the normal loading window, not this hazard,
// so it must NOT be treated as detached.
function menuDetached() {
  const el = open && open.el;
  if (!el) return false;
  if (typeof el.isConnected === 'boolean') return !el.isConnected;
  return !el.parentNode;
}

function paintMenu(ta) {
  if (!open || typeof document === 'undefined') return;
  const wrap = ta.closest && ta.closest('.composer, .m-composer');
  if (!wrap) return;
  const existing = wrap.querySelector('.mention-menu');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  const html = open.error ? ERROR_HTML : renderPickerHtml(open.items, open.highlighted);
  wrap.insertAdjacentHTML('beforeend', html);
  open.el = wrap.querySelector('.mention-menu');
}

function runQuery(ta, tokenStart, query) {
  const myToken = ++fetchToken;
  const q = encodeURIComponent(query || '');
  apiGet(`/api/palette?q=${q}&kinds=note,document&limit=${LIMIT}`)
    .then((res) => {
      if (myToken !== fetchToken || !open || open.start !== tokenStart) return; // stale
      open.items = (res && res.results) || [];
      open.highlighted = 0;
      open.error = false;
      paintMenu(ta);
    })
    .catch(() => {
      if (myToken !== fetchToken || !open || open.start !== tokenStart) return;
      open.items = [];
      open.error = true;
      paintMenu(ta);
    });
}

function onInput(e) {
  const ta = e.target;
  if (!ta || !ta.getAttribute) return;
  const fk = ta.getAttribute('data-focus');
  if (fk !== 'draft' && fk !== 'mdraft') return;
  const caret = ta.selectionStart == null ? (ta.value || '').length : ta.selectionStart;
  const hit = mentionTokenAtCaret(ta.value || '', caret);
  if (!hit) { if (open) closeMenu(); return; }
  if (open && open.start === hit.start) {
    open.query = hit.query;
    // Fix round 1, Important 2: keep the live textarea reference current.
    // `ta` here is whatever element just fired 'input', which is always the
    // authoritative "current" one -- a background render() can replace the
    // textarea object even when the token itself survives (same caret/
    // start), and onSelectionChange/commitPick must track the element the
    // user is actually typing into, not whichever one was live when the
    // token first opened.
    open.ta = ta;
  } else {
    open = { start: hit.start, ta, query: hit.query, items: [], highlighted: 0, error: false };
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runQuery(ta, hit.start, hit.query), DEBOUNCE_MS);
}

// Fix round 1, Important 2: the one place every commit path funnels through
// ("before any commit" per the fix-round ask) -- both the keydown Enter/Tab
// path and onClick's row-pick path call this. Bails without writing
// anything when the textarea passed in isn't the one the token was opened
// against, or when the painted menu is no longer attached: either signals
// the composer was rebuilt out from under the picker, and committing here
// would silently insert a mention into a textarea the user can't see (the
// same hazard app.js's ghost-suggestion guards against with its own
// `offsetParent !== null` check, "Tab must never insert text the user can't
// see" -- app.js ~1494-1496).
function commitPick(ta, item) {
  if (!open || ta !== open.ta || menuDetached()) { open = null; return; }
  const caret = ta.selectionStart == null ? (ta.value || '').length : ta.selectionStart;
  const { text, caret: newCaret } = insertMention(ta.value || '', open.start, caret, item);
  ta.value = text;
  if (ta.setSelectionRange) ta.setSelectionRange(newCaret, newCaret);
  if (runtime.state) runtime.state[composerField(ta)] = text;
  closeMenu();
}

/**
 * Exported for app.js's keydown precedence chain (slotted after the slash
 * menu, before the plain-Enter fallthrough -- see app.js:1467-1469).
 * Returns true when it handled the key: the caller must preventDefault()
 * and stop further handling.
 */
export function handleMentionKeydown(e, ta) {
  if (!open || !ta) return false;
  // Fix round 1, Important 2: `ta` not matching the textarea the token was
  // opened against, or the painted menu no longer being attached, both mean
  // a background render() replaced the composer out from under this state.
  // Bail and clear rather than act on (or commit into) something the user
  // can no longer see -- see menuDetached()'s banner and commitPick's.
  if (ta !== open.ta || menuDetached()) { open = null; return false; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open.items.length) return false;
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    open.highlighted = (open.highlighted + dir + open.items.length) % open.items.length;
    paintMenu(ta);
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (!open.items.length) { closeMenu(); return false; } // nothing to pick -> fall through
    commitPick(ta, open.items[open.highlighted]);
    return true;
  }
  if (e.key === 'Escape') {
    closeMenu();
    return true;
  }
  return false;
}

// Tap-to-pick (mobile primarily, but works for a mouse click too). Also
// closes the menu on a click anywhere else -- neither composer re-renders
// on every keystroke once a mention token is open (draft only rebuilds
// root.innerHTML when slash-relevant, app.js:1213; mdraft never rebuilds on
// input at all, app.js:1181), so nothing but an explicit close removes the
// manually-inserted `.mention-menu` node the render loop doesn't own. Two
// kinds of clicks are NOT "outside" and must not close it: a click back in
// the same textarea (a caret move, which onSelectionChange's shouldClose
// check handles more precisely -- it knows whether the caret is still
// inside the open token) and a click anywhere else inside `.mention-menu`
// itself (its own padding, or the "No matches"/error copy -- Fix round 1,
// Minor: that used to read as "outside" too and closed the menu the user
// was still interacting with).
function onClick(e) {
  const row = e.target && e.target.closest && e.target.closest('.mention-row');
  if (row) {
    if (!open) return;
    const idx = Number(row.getAttribute('data-mention-idx'));
    if (!Number.isInteger(idx) || !open.items[idx]) return;
    const ta = open.ta;
    commitPick(ta, open.items[idx]);
    if (ta.focus) ta.focus();
    return;
  }
  if (!open) return;
  const insideMenu = e.target && e.target.closest && e.target.closest('.mention-menu');
  if (insideMenu || e.target === open.ta) return;
  closeMenu();
}

// A caret move that leaves the open token's range (a click elsewhere in the
// same textarea, arrow-left past the "@", ...) closes the menu, mirroring
// the slash menu's "moving out" behavior. selectionchange is the one event
// that fires for an in-field caret move without also firing 'input'.
function onSelectionChange() {
  if (!open) return;
  const ta = open.ta;
  if (!ta || typeof document === 'undefined' || document.activeElement !== ta) return;
  const caret = ta.selectionStart == null ? (ta.value || '').length : ta.selectionStart;
  if (shouldClose(ta.value || '', caret, open.start)) closeMenu();
}

// Fix round 1, Important 4: a test seam for this widget's private DOM
// wiring. `handleMentionKeydown`/`initMentionPicker` are app.js's real
// public interface (unchanged) -- these extra names exist ONLY so
// __tests__/mention-picker.test.js can open the menu (onInput), simulate a
// click (onClick), force-close it (closeMenu), and inspect the live `open`
// state (getOpenState) without going through a real document event
// dispatch system the test's fake DOM doesn't implement.
export const __mentionPickerTestHooks = { onInput, onClick, closeMenu, getOpenState: () => open };

let inited = false;

export function initMentionPicker() {
  if (inited || typeof document === 'undefined') return;
  inited = true;
  document.addEventListener('input', onInput, true);
  document.addEventListener('click', onClick);
  document.addEventListener('selectionchange', onSelectionChange);
}

// Self-boot on import (app.js just needs to import this module once) --
// same guard as live/jobs.js:401-408: a module evaluated AFTER
// DOMContentLoaded already fired (a lazily-loaded chunk, a slow script tag)
// would otherwise never see that event and never call initMentionPicker.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMentionPicker, { once: true });
  } else {
    initMentionPicker();
  }
}
