// Shared clear "×" for the redesign's search/filter boxes (sidebar
// conversation filter, ⌘K switcher, mobile conversation drawer, email /
// library / notes filters).
//
// The button is ALWAYS in the markup; CSS shows it only while the input has
// text (`.oc-search:has(input:not(:placeholder-shown)) .oc-search-clear`, and
// the .m-search / .m-drawer-search twins in mobile.css). Driving visibility
// off the DOM rather than state means the × appears on the first keystroke
// even for fields whose re-render is debounced (DEBOUNCED_SEARCH_FIELDS in
// app.js) or skipped mid-type on mobile.
//
// Deliberately NO data-focus on the button: app.js's keydown handler routes
// on e.target's data-focus, so a × carrying data-focus="switchQuery" would
// make Enter pick the highlighted switcher row instead of clearing. The
// clearField action refocuses the input itself after render.
import { I } from './icons.js';
import { esc } from './dom.js';

// Model fields that are search/filter boxes → the action owning their
// semantic results (null = plain local filter, nothing else to reset).
// Anything not listed here is not a search box and clearSearchField refuses
// it, so a stray data-arg can never blank the composer draft.
export const SEARCH_FIELDS = Object.freeze({
  convFilter: 'convSearch',
  switchQuery: 'switcherQuery',
  emailQuery: null,
  libQuery: null,
  notesFilter: null,
});

/** Markup for the × button; place it right after the box's <input>. */
export function searchClearBtn(field) {
  const f = esc(field);
  return `<button type="button" class="oc-search-clear" data-act="clearField" data-arg="${f}" title="Clear" aria-label="Clear search">${I.x(13)}</button>`;
}

/**
 * Blank `state[field]` and reset its paired semantic search (if any).
 * Returns true when the field was a known search box and got cleared.
 * `actions` may be missing the paired action (live/chat.js merges its
 * actions in via a dynamic import) — then only the field is blanked.
 */
export function clearSearchField(state, field, actions) {
  if (!state || !field || !Object.prototype.hasOwnProperty.call(SEARCH_FIELDS, field)) return false;
  state[field] = '';
  const paired = SEARCH_FIELDS[field];
  const fn = paired && actions && actions[paired];
  if (typeof fn === 'function') fn('');
  return true;
}
