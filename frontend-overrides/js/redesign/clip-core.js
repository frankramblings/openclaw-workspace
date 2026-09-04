// Pure helpers for the URL-clip composer/Library entry points (Task C3).
// No DOM, no fetch -- app.js and live/library.js import these directly, the
// same split library-logic.js documents for its own pure helpers. Leaf
// module: only imports dom.js, so nothing that imports this (including
// deeplink.js, which sits outside redesign/) risks an import cycle.

import { esc } from './dom.js';

const _URL_ONLY_RE = /^https?:\/\/[^\s<>"']+$/i;

// True iff `text`, trimmed, is exactly one http(s) URL and nothing else --
// no leading/trailing prose, no second URL, no bare "example.com" (a
// scheme is required, matching backend/clip_guard.check_url's policy).
export function isUrlOnlyDraft(text) {
  const t = (text || '').trim();
  if (!t || /\s/.test(t)) return false;
  return _URL_ONLY_RE.test(t);
}

const CLIP_ERROR_MESSAGES = {
  bad_request: 'That request was not formed correctly.',
  bad_url: 'That does not look like a web address.',
  blocked_host: 'That address cannot be clipped, it looks like a private or local host.',
  dns_failed: 'Could not find that host. Check the address and try again.',
  fetch_failed: 'Could not reach that page. Try again in a moment.',
  too_large: 'That page is too large to clip.',
  unsupported_type: 'That page is not a format that can be clipped, only articles, text, and PDFs.',
  extract_failed: 'Could not read any article text from that page.',
  write_failed: 'Clipped the page but could not save it. Try again.',
};

// Map a clip API failure (an ApiError from live/api.js, whose .body is the
// {ok:false,error,detail} envelope backend/clip.py returns, or any other
// thrown value) to one short sentence for a toast/alert.
export function clipErrorMessage(err) {
  const code = err && err.body && typeof err.body === 'object' ? err.body.error : null;
  return CLIP_ERROR_MESSAGES[code] || 'Could not clip that page. Try again.';
}

// HTML for the composer's inline "Clip" chip: a direct-DOM widget painted
// the same way live/chat.js's ghost suggestion is (insertAdjacentHTML,
// outside the render loop) because the draft/mdraft composers are
// explicitly exempted from a full render() on every keystroke
// (redesign/app.js's input handler, "must not re-render on every
// keystroke"). data-act="clipDraftUrl" is still picked up by app.js's
// existing delegated [data-act] click handler on `root` even though this
// element is inserted outside any render() call -- the same way the ghost
// suggestion's data-act="acceptSuggest" span already is.
export function clipChipHtml(url) {
  return `<button type="button" class="clip-chip ocbtn" data-act="clipDraftUrl" `
    + `data-arg="${esc(url)}" title="Clip this page as a document" `
    + `style="position:absolute;right:56px;bottom:10px;padding:4px 10px;border-radius:999px;font-size:12px">Clip</button>`;
}
