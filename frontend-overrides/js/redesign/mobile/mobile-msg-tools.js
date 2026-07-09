// Mobile per-message action affordances. Pure render — every button dispatches
// through app.js's existing data-act delegation. No DOM access, no state
// mutation. Handler contract mirrors surfaces.js:msgTools so the same
// copyMessage / branchFromMessage / downloadMessage / downloadMessagePDF /
// toggleMsgMenu handlers in live/chat.js drive both surfaces.

import { I } from '../icons.js';
import { esc } from '../dom.js';

export function mdMenu(m, open) {
  if (!open) return '';
  return `<div class="m-msg-dl-menu" data-act="noop" role="menu">`
    + `<button class="m-msg-dl-item" data-act="downloadMessage" data-arg="${esc(m.id)}" role="menuitem"><span class="m-msg-dl-ic">${I.download(15)}</span>Markdown</button>`
    + `<button class="m-msg-dl-item" data-act="downloadMessagePDF" data-arg="${esc(m.id)}" role="menuitem"><span class="m-msg-dl-ic">${I.download(15)}</span>PDF</button>`
  + `</div>`;
}

export function assistantToolbar(m, s) {
  const hasText = String(m.text || '').trim().length > 0;
  if (!hasText || m.streaming || m.error) return '';
  const open = s?.live?.chat?.msgMenuOpen === m.id;
  return `<div class="m-msg-toolbar" data-msg-id="${esc(m.id)}">`
    + `<button class="m-msg-tool" data-act="copyMessage" data-arg="${esc(m.id)}" aria-label="Copy">${I.copy(17)}</button>`
    + `<button class="m-msg-tool" data-act="branchFromMessage" data-arg="${esc(m.id)}" aria-label="Branch">${I.branch(17)}</button>`
    + `<div class="m-msg-dl-wrap">`
      + `<button class="m-msg-tool${open ? ' on' : ''}" data-act="toggleMsgMenu" data-arg="${esc(m.id)}" aria-label="Download" aria-haspopup="menu" aria-expanded="${open}">${I.download(17)}</button>`
      + mdMenu(m, open)
    + `</div>`
  + `</div>`;
}

export function userSheet(m, s) {
  if (s?.live?.chat?.mobileSheetMsgId !== m.id) return '';
  const preview = esc(String(m.text || '').slice(0, 240));
  const row = (act, label, iconHtml) =>
    `<button class="m-msg-sheet-row" data-act="${act}" data-arg="${esc(m.id)}" data-close-sheet="1">`
    + `<span class="m-msg-sheet-ic">${iconHtml}</span><span class="m-msg-sheet-lbl">${label}</span>`
  + `</button>`;
  return `<div class="m-msg-sheet-backdrop" data-act="closeMobileMsgSheet"></div>`
    + `<div class="m-msg-sheet" role="dialog" aria-modal="true">`
      + `<div class="m-msg-sheet-preview">${preview}</div>`
      + row('copyMessage', 'Copy', I.copy(19))
      + row('branchFromMessage', 'Branch from here', I.branch(19))
      + row('downloadMessage', 'Copy as Markdown', I.download(19))
      + row('downloadMessagePDF', 'Save as PDF', I.download(19))
      + `<button class="m-msg-sheet-row m-msg-sheet-cancel" data-act="closeMobileMsgSheet"><span class="m-msg-sheet-lbl">Cancel</span></button>`
    + `</div>`;
}
