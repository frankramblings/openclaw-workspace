// Ghost-suggestion overlay markup, shared by the desktop composer
// (surfaces.js) and the mobile composer (mobile/mobile-surfaces.js).
// Desktop ghost is pointer-events:none (Tab accepts; clicks must fall through
// to focus the textarea) so it carries no data-act. Mobile has no Tab key —
// the ghost itself is the tap-to-accept control.
import { esc } from './dom.js';

export function suggestGhost(suggest, draft, { mobile = false } = {}) {
  const text = suggest && suggest.text;
  if (!text || String(draft || '').trim()) return '';
  if (mobile) {
    return `<span class="ghost-suggest m-ghost" data-act="acceptSuggest" role="button" aria-label="Use suggestion: ${esc(text)}">${esc(text)}</span>`;
  }
  return `<span class="ghost-suggest" aria-hidden="true">${esc(text)}<span class="tabhint">tab</span></span>`;
}
