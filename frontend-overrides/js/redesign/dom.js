// Tiny DOM/template helpers for the redesign's string-template rendering.

/** Escape text for safe interpolation into HTML. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escape for an HTML attribute value. */
export function attr(s) { return esc(s); }

/** Join an array of html strings. Null-safe: `when(cond, `…${map(x)}…`)` evaluates
 *  its arguments eagerly, so a falsy `x` must not throw and blank the whole app. */
export function map(arr, fn) { return (arr || []).map(fn).join(''); }

/** Conditionally render. */
export function when(cond, html) { return cond ? html : ''; }

/** Flatten markdown to plain text for compact previews (inbox/notification
 *  snippets) where raw `**bold**`, `[text](url)`, `#`, `` `code` `` markers would
 *  otherwise show literally. Conservative: only unwraps paired/leading markers. */
export function stripMd(s) {
  return String(s == null ? '' : s)
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')        // `code` / ```code```
    .replace(/\*\*([^*]+)\*\*/g, '$1')             // **bold**
    .replace(/__([^_]+)__/g, '$1')                 // __bold__
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // [text](url) → text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')            // # heading
    .replace(/^\s{0,3}[-*+]\s+/gm, '')             // - bullet
    .replace(/\s+/g, ' ')                           // collapse whitespace for one-line previews
    .trim();
}
