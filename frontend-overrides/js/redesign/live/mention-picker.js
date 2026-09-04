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

let open = null;        // { start, ta, query, items, highlighted } | null
let debounceTimer = null;
let fetchToken = 0;      // staleness guard: only the newest debounced fetch may paint

function composerField(ta) {
  return ta.getAttribute('data-focus') === 'mdraft' ? 'mdraft' : 'draft';
}

function closeMenu() {
  open = null;
  if (typeof document === 'undefined') return;
  const el = document.querySelector('.mention-menu');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function paintMenu(ta) {
  if (!open || typeof document === 'undefined') return;
  const wrap = ta.closest && ta.closest('.composer, .m-composer');
  if (!wrap) return;
  const existing = wrap.querySelector('.mention-menu');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  wrap.insertAdjacentHTML('beforeend', renderPickerHtml(open.items, open.highlighted));
}

function runQuery(ta, tokenStart, query) {
  const myToken = ++fetchToken;
  const q = encodeURIComponent(query || '');
  apiGet(`/api/palette?q=${q}&kinds=note,document&limit=${LIMIT}`)
    .then((res) => {
      if (myToken !== fetchToken || !open || open.start !== tokenStart) return; // stale
      open.items = (res && res.results) || [];
      open.highlighted = 0;
      paintMenu(ta);
    })
    .catch(() => {
      if (myToken !== fetchToken || !open || open.start !== tokenStart) return;
      open.items = [];
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
  } else {
    open = { start: hit.start, ta, query: hit.query, items: [], highlighted: 0 };
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runQuery(ta, hit.start, hit.query), DEBOUNCE_MS);
}

function commitPick(ta, item) {
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
// manually-inserted `.mention-menu` node the render loop doesn't own. A
// click that lands back in the same textarea is a caret move, not an
// "outside" click -- onSelectionChange's shouldClose check handles that
// case more precisely (it knows whether the caret is still inside the
// open token), so it's excluded here to avoid fighting that logic.
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
  if (open && e.target !== open.ta) closeMenu();
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
