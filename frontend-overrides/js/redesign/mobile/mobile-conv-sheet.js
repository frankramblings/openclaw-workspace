// Mobile thread-actions sheet: the touch equivalent of the desktop sidebar's
// hover-only "⋯" conversation menu (surfaces.js convMenu). Opened by the "⋯"
// button on a Conversations-drawer row or by a long-press on the row itself.
//
// Lives in its own module rather than mobile-sheets.js: that file is already
// five renderers and the shared drawer list, and this one is a pure function
// with a single, separately-tested contract.
//
// Pure render. Every row dispatches the SAME action the desktop menu does
// (renameSession / toggleFavorite / toggleUnread / copyTranscript /
// moveToProject / archiveSession / deleteSession), so there is one handler per
// behavior, not one per surface.

import { I } from '../icons.js';
import { esc } from '../dom.js';
import { moveMenuItems } from '../project-menu.js';

// Self-guarded like userSheet()/renderSnoozeSheet(): renders '' when no row is
// selected, so the caller can splice it into the sheet stack unconditionally.
export function convActionSheet(s) {
  const chat = (s && s.live && s.live.chat) || {};
  const id = chat.mobileConvSheetId;
  if (!id) return '';
  const row = (chat.groups || []).flatMap((g) => g.rows || []).find((r) => r && r.id === id);
  if (!row) return '';
  const unread = !!row.unread;
  const fav = row.important ? 'Unfavorite' : 'Favorite';

  const rowHtml = (act, arg, glyph, label, extra = '') =>
    `<button class="m-conv-sheet-row${extra}" data-act="${act}" data-arg="${esc(arg)}" data-close-sheet="1">`
    + `<span class="m-conv-sheet-ic">${glyph}</span><span class="m-conv-sheet-lbl">${label}</span>`
    + `</button>`;
  const act = (name, glyph, label, extra = '') => rowHtml(name, id, glyph, label, extra);

  // Move rows reuse the desktop's own item builder so the two surfaces can
  // never disagree about which projects are offered or which one is current.
  // The "New project…" entry is deliberately dropped here: creating a project
  // is a prompt-driven desktop flow, not something to hang off a bottom sheet.
  const moveRows = moveMenuItems(id, (s.live && s.live.projects) || [], row.folder || null)
    .filter((it) => it.kind !== 'new')
    .map((it) => rowHtml(
      it.act, it.arg,
      it.kind === 'none' ? I.x(19) : I.folder(19),
      it.kind === 'none' ? 'Remove from project' : esc(it.label),
      it.on ? ' on' : ''))
    .join('');

  return `<div class="m-conv-sheet-backdrop" data-act="closeConvActions"></div>`
    + `<div class="m-conv-sheet" role="dialog" aria-modal="true" aria-label="Conversation actions">`
      + `<div class="m-conv-sheet-title">${esc(row.title || 'New chat')}</div>`
      + act('renameSession', I.pencil(19), 'Rename')
      + act('toggleFavorite', I.star(19, !!row.important), fav)
      + act('toggleUnread', unread ? I.check(19) : I.dot(19), unread ? 'Mark read' : 'Mark unread')
      + act('copyTranscript', I.copy(19), 'Copy chat')
      + moveRows
      + act('archiveSession', I.archive(19), 'Archive')
      + act('deleteSession', I.trash(19), 'Delete', ' m-conv-sheet-danger')
      + `<button class="m-conv-sheet-row m-conv-sheet-cancel" data-act="closeConvActions"><span class="m-conv-sheet-lbl">Cancel</span></button>`
    + `</div>`;
}
