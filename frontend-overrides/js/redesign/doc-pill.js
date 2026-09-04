// The composer's "Editing: <doc>" pill, and the one rule that decides whether
// a chat send attaches the open Library document.
//
// Fix wave, Minor 2: the markup and its guard used to be re-implemented
// inline in both surfaces.js and mobile/mobile-surfaces.js, so the attach
// rule had three owners (those two plus document-editor.js's
// libraryDocIdFor). It lives here now: a pure, DOM-free module that imports
// only esc(), so live/document-editor.js can re-export libraryDocIdFor from
// it without either surface renderer having to import the editor.

import { esc } from './dom.js';

/**
 * The Library document id a chat send should carry as active_doc_id, or null.
 * Only a Library doc (an `id` with no `wsPath`, so never a workspace-file
 * buffer) that is open, loaded, writable, and hasn't been detached via the
 * pill's x. Mirrors saveTarget(d).kind === 'doc' in document-editor.js.
 */
export function libraryDocIdFor(d) {
  if (!d || !d.open || d.attachDetached) return null;
  if (d.loadFailed || d.readOnly) return null;
  if (d.wsPath) return null;
  return d.id || null;
}

/**
 * The pill's HTML for the given app state, or '' when nothing is attached.
 * `cls` is the base class ('oc-doc-pill' desktop, 'm-doc-pill' mobile); the
 * x button uses `${cls}-x`. `role`/`title` add the desktop-only attributes.
 */
export function docPillHtml(s, opts = {}) {
  const cls = opts.cls || 'oc-doc-pill';
  if (!libraryDocIdFor(s && s.docEditor)) return '';
  const title = s.docEditor.title || 'Untitled document';
  const roleAttr = opts.role ? ' role="status"' : '';
  const titleAttr = opts.title ? ' title="Stop attaching this document to your next message"' : '';
  return `<div class="${cls}"${roleAttr}>Editing: <b>${esc(title)}</b>`
    + `<button type="button" class="${cls}-x" data-act="detachDocPill"${titleAttr}`
    + ' aria-label="Stop attaching this document">×</button></div>';
}
