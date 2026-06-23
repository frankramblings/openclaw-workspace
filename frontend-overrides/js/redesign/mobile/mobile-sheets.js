// Mobile bottom sheets: the swipe-up companion (Terminal/Files over Chat) and
// the quick-capture modal (the ➕ tab — a mobile-only surface).

import { I, icon } from '../icons.js';
import { esc, map, when } from '../dom.js';
import { AVATAR, FS, EXT_COLOR } from '../data.js';
import { CAPTURE_TYPES, CAPTURE_PARSE, RECENT_CAPTURES } from './mobile-data.js';

// compact file tree (shared FS data) for the companion sheet's Files tab
function fileTree(s) {
  const tree = s.live?.companion?.tree ?? FS;
  const rows = [];
  const walk = (nodes, depth, prefix) => {
    for (const node of nodes) {
      const path = prefix ? `${prefix}/${node.n}` : node.n;
      const pad = 16 + depth * 15;
      if (node.t === 'dir') {
        const open = !!s.fsOpen[path];
        const chev = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="chev" style="transition:transform .12s;transform:rotate(${open ? '90deg' : '0deg'})"><path d="m9 18 6-6-6-6"/></svg>`;
        rows.push(`<div class="fs-dir ocfile" data-act="toggleFs" data-arg="${esc(path)}" style="padding-left:${pad}px;padding-right:14px">${chev}${I.folder(14)}<span class="nm">${esc(node.n)}</span>${node.meta ? `<span class="meta">${esc(node.meta)}</span>` : ''}</div>`);
        if (open && node.children) walk(node.children, depth + 1, path);
      } else {
        rows.push(`<div class="fs-file" style="padding-left:${pad + 17}px;padding-right:14px">${I.file(13, EXT_COLOR[node.t] || 'var(--mut)')}<span class="nm">${esc(node.n)}</span></div>`);
      }
    }
  };
  walk(tree, 0, '');
  return rows.join('');
}

export function renderCompanionSheet(s) {
  const onTerm = s.companionTab !== 'files';
  return `
  <div class="m-scrim" data-act="closeCompanion"></div>
  <div class="m-sheet companion">
    <div class="m-grab"><div class="h"></div></div>
    <div class="m-seg-row">
      <div class="seg">
        <span class="${onTerm ? 'active' : ''}" data-act="companionTab" data-arg="terminal">Terminal</span>
        <span class="${!onTerm ? 'active' : ''}" data-act="companionTab" data-arg="files">Files</span>
      </div>
      <button class="m-sheet-x" data-act="closeCompanion">${I.x(15)}</button>
    </div>
    ${onTerm ? `
    <div class="m-term" style="display:flex;flex-direction:column;padding:0">
      <div class="cwd" style="padding:8px 16px 4px">~/.openclaw/workspace · this chat</div>
      <div style="flex:1;min-height:0" data-term-mount></div>
    </div>` : `<div class="m-files">${fileTree(s)}</div>`}
  </div>`;
}

export function renderCaptureSheet(s) {
  const type = s.captureType || 'remind';
  const draft = s.captureDraft || '';
  const parse = CAPTURE_PARSE[type];
  return `
  <div class="m-scrim" data-act="closeCapture"></div>
  <div class="m-sheet capture">
    <div class="m-grab"><div class="h"></div></div>
    <div class="m-cap-head"><div class="av"><img src="${AVATAR}" alt="Gary"></div><span class="t">Quick capture</span><div class="m-spacer"></div><button class="cancel" data-act="closeCapture">Cancel</button></div>
    <div class="m-cap-input"><textarea data-model="captureDraft" data-focus="mcapture" rows="2" placeholder="Remind me to send the Cannes deck to legal before Friday">${esc(draft)}</textarea></div>
    ${when(draft.trim().length > 0, `<div class="m-cap-parse"><span class="k">Gary parsed:</span>${esc(parse)}</div>`)}
    <div class="m-cap-types">
      ${map(CAPTURE_TYPES, (t) => `<span class="m-cap-type${type === t.id ? ' active' : ''}" data-act="setCaptureType" data-arg="${t.id}">${t.glyph} ${esc(t.label)}</span>`)}
    </div>
    <button class="m-cap-send" data-act="sendCapture">${I.send(17)}Send to Gary</button>
    <div class="m-cap-recent-lbl">RECENT CAPTURES</div>
    ${map(RECENT_CAPTURES, (r) => `<div class="m-cap-recent"><span class="g" style="color:${r.color}">${r.glyph}</span><span class="tx">${esc(r.text)}</span><span class="ty">${esc(r.type)}</span></div>`)}
  </div>`;
}
