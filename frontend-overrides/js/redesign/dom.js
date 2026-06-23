// Tiny DOM/template helpers for the redesign's string-template rendering.

/** Escape text for safe interpolation into HTML. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escape for an HTML attribute value. */
export function attr(s) { return esc(s); }

/** Join an array of html strings. */
export function map(arr, fn) { return arr.map(fn).join(''); }

/** Conditionally render. */
export function when(cond, html) { return cond ? html : ''; }
