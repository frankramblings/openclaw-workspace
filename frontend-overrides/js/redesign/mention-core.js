// Pure helpers for the @-mention composer trigger: caret-aware token
// detection, insertion text, close rules, and picker markup. No DOM globals
// touched here -- live/mention-picker.js does the direct-DOM wiring and
// keydown handling; every function below is unit-testable with plain
// strings/objects (same split as document-editor.js's saveTarget/
// resetBufferIdentity and deeplink.js's planForAction).
import { esc } from './dom.js';

// An "@" opens a mention token only at the very start of the draft or right
// after whitespace -- an "@" glued to a preceding non-whitespace character
// (frank@example.com) never triggers, mirroring spec 1.1. Unlike the slash
// command convention's simple "draft starts with /" check, this has to be
// caret-aware: "@" can open a token anywhere mid-message, not just at
// position 0, so the regex is applied to the text UP TO THE CARET and
// anchored ($) to its end -- only the "@" closest to (and before) the caret,
// with no intervening whitespace or second "@", can be the open token.
const MENTION_TRIGGER_RE = /(^|\s)@([^\s@]*)$/;

// A candidate query that contains "[", "]", "(" or ")" is never a mention
// in progress -- it's the caret sitting somewhere inside an ALREADY
// completed token (`@[Title](note:id)`), which mentionTokenAtCaret's plain
// backward scan can't otherwise tell apart from a fresh trigger (fix round
// 1, Critical 2: this used to hand back garbage queries like
// "[Groceries](note:n1)").
const MENTION_QUERY_GARBAGE_RE = /[[\]()]/;

/**
 * mentionTokenAtCaret(text, caret) -> {start, query} | null
 * `start` is the index of the "@" itself; `query` is everything typed since
 * it, up to (not past) the caret.
 */
export function mentionTokenAtCaret(text, caret) {
  if (typeof text !== 'string' || typeof caret !== 'number') return null;
  const head = text.slice(0, caret);
  const m = MENTION_TRIGGER_RE.exec(head);
  if (!m) return null;
  const query = m[2];
  if (MENTION_QUERY_GARBAGE_RE.test(query)) return null;
  return { start: m.index + m[1].length, query };
}

/**
 * shouldClose(text, caret, tokenStart) -> boolean
 * True once the token opened at `tokenStart` is no longer valid at `caret`:
 * the caret moved to or before the "@", the "@" itself is gone (text edited
 * around it), or whitespace/a second "@" now sits between them.
 */
export function shouldClose(text, caret, tokenStart) {
  if (typeof text !== 'string' || typeof caret !== 'number') return true;
  if (caret <= tokenStart || text[tokenStart] !== '@') return true;
  return /[\s@]/.test(text.slice(tokenStart + 1, caret));
}

// Mirrors backend/mentions.py's MENTION_RE id class exactly
// (`[A-Za-z0-9_-]{1,32}`): an id that wouldn't round-trip through the
// backend's parser must never be written into the draft (fix round 1,
// Important 3).
const MENTION_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

// backend/mentions.py's MENTION_RE title class is `[^\]\n]{1,200}` -- a
// title containing "]" or "\n" would either close the token early or break
// the single-line token grammar, and the backend would silently ignore the
// whole token (fix round 1, Critical 1). Sanitizes at least as strictly as
// the backend accepts: drop "]", "\r" and "\n" outright (not replaced with
// a space -- these are hostile bytes, not word separators), collapse any
// remaining whitespace runs to one space, trim, and cap at 200 characters.
// Parentheses are left alone: they don't appear in the backend's exclusion
// class and can't prematurely close the title (only "]" can).
function sanitizeMentionTitle(rawTitle, id) {
  const cleaned = String(rawTitle == null ? '' : rawTitle)
    .replace(/[\]\r\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return cleaned || String(id);
}

/**
 * insertMention(text, start, caret, item) -> {text, caret}
 * Replaces the open token's range [start, caret) with the plain-text
 * mention token `@[Title](note:id)` / `@[Title](doc:id)` (spec ruling 1:
 * no rich chips in v1), followed by exactly one space. When the text right
 * after the caret already starts with whitespace (inserting a mention
 * before existing text, not at the end of the draft), the token's own
 * trailing space is skipped instead of doubling up with the one already
 * there. Returns the caret placed right after the token (and its trailing
 * space, when one was added). `item.kind` comes from /api/palette's
 * vocabulary ("note" | "document" | "session"); "document" maps to the
 * short "doc" used inside the token, everything else defaults to "note".
 * `item.title` is sanitized to fit backend/mentions.py's title grammar
 * (falling back to the id when nothing printable survives); `item.id` is
 * validated against the backend's id grammar and, when it fails, nothing is
 * inserted at all -- `text`/`caret` come back unchanged (fix round 1,
 * Critical 1 and Important 3).
 */
export function insertMention(text, start, caret, item) {
  const id = (item && item.id) || '';
  if (!MENTION_ID_RE.test(id)) return { text, caret };
  const kind = (item && item.kind === 'document') ? 'doc' : 'note';
  const title = sanitizeMentionTitle(item && item.title, id);
  const before = text.slice(0, start);
  const after = text.slice(caret);
  const trailer = /^\s/.test(after) ? '' : ' ';
  const token = `@[${title}](${kind}:${id})${trailer}`;
  return { text: before + token + after, caret: before.length + token.length };
}

/**
 * renderPickerHtml(items, highlighted) -> HTML for the direct-DOM picker
 * (live/mention-picker.js inserts this with insertAdjacentHTML). `items`
 * are /api/palette results ({kind, id, title, ...}); `highlighted` is an
 * index into `items`. Titles are escaped; no em dashes in any copy.
 */
export function renderPickerHtml(items, highlighted) {
  if (!items || !items.length) {
    return '<div class="mention-menu"><div class="mention-empty">No matches</div></div>';
  }
  const rows = items.map((it, i) => {
    const kindLabel = it.kind === 'document' ? 'Document' : 'Note';
    const cls = i === highlighted ? 'mention-row sel' : 'mention-row';
    return `<div class="${cls}" data-mention-idx="${i}">`
         + `<span class="mention-title">${esc(it.title || '')}</span>`
         + `<span class="mention-kind">${esc(kindLabel)}</span>`
         + `</div>`;
  }).join('');
  return `<div class="mention-menu">${rows}</div>`;
}
