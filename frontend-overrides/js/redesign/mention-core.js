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
  return { start: m.index + m[1].length, query: m[2] };
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
 */
export function insertMention(text, start, caret, item) {
  const kind = (item && item.kind === 'document') ? 'doc' : 'note';
  const title = (item && item.title) || '';
  const id = (item && item.id) || '';
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
