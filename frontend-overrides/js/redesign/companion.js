// Adaptive companion (Terminal · Files · Gary), split mini-IDE, and the
// collapsed reveal strip. Mirrors the design reference's right-pane behavior.

import { I, icon } from './icons.js';
import { esc, map, when } from './dom.js';
import { AVATAR, FS, EXT_COLOR, DOCK } from './data.js';

// effective tab for a surface (Gary suppressed on chat; chat defaults Terminal)
export function effectiveTab(s) {
  const raw = s.compTab || (s.surface === 'chat' ? 'terminal' : 'gary');
  return (s.surface === 'chat' && raw === 'gary') ? 'terminal' : raw;
}

// flatten the workspace tree into renderable rows honoring fsOpen
function fsRows(s) {
  const tree = s.live?.companion?.tree ?? FS;
  const rows = [];
  const walk = (nodes, depth, prefix) => {
    for (const node of nodes) {
      const path = prefix ? `${prefix}/${node.n}` : node.n;
      if (node.t === 'dir') {
        const open = !!s.fsOpen[path];
        rows.push({ isDir: true, name: node.n, meta: node.meta || '', open, pad: 8 + depth * 15, path });
        if (open && node.children) walk(node.children, depth + 1, path);
      } else {
        rows.push({ isDir: false, name: node.n, pad: 8 + depth * 15 + 17, color: EXT_COLOR[node.t] || 'var(--mut)' });
      }
    }
  };
  walk(tree, 0, '');
  return rows;
}

function fileTreeHtml(s, { dense } = {}) {
  return fsRows(s).map((r) => {
    if (r.isDir) {
      const chev = `<svg width="${dense ? 10 : 11}" height="${dense ? 10 : 11}" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="chev" style="transform:rotate(${r.open ? '90deg' : '0deg'})"><path d="m9 18 6-6-6-6"/></svg>`;
      return `<div class="fs-dir ocfile" data-act="toggleFs" data-arg="${esc(r.path)}" style="padding-left:${r.pad}px">${chev}${I.folder(dense ? 13 : 14)}<span class="nm">${esc(r.name)}</span>${r.meta ? `<span class="meta">${esc(r.meta)}</span>` : ''}</div>`;
    }
    return `<div class="fs-file" style="padding-left:${r.pad}px">${I.file(dense ? 12 : 13, r.color)}<span class="nm">${esc(r.name)}</span></div>`;
  }).join('');
}

const TERM_SUBHEAD = `<div class="comp-subhead"><span class="cwd">~/.openclaw/workspace</span><span class="sub">· this chat</span><div class="oc-spacer"></div><span class="comp-live"><span class="d"></span>live</span></div>`;
// the live xterm overlay (live/terminal.js) positions itself over this mount
const TERM_BODY = `<div class="term-body" data-term-mount></div>`;

function filesPane(s) {
  return `
  <div class="files-subtabs">
    <span class="ft">Files</span>
    <span class="at">Artifacts <span class="n">0</span></span>
    <div class="oc-spacer"></div>
    <span class="ws-tool" data-act="wsNewFile" title="New file" style="cursor:pointer;padding:0 5px;color:var(--faint)">${I.file ? I.file(13, 'currentColor') : '📄'}<span style="font-size:14px">＋</span></span>
    <span class="ws-tool" data-act="wsNewFolder" title="New folder" style="cursor:pointer;padding:0 5px;color:var(--faint)">${I.folder(13, 'currentColor')}<span style="font-size:14px">＋</span></span>
    <label class="ws-tool" title="Upload files" style="cursor:pointer;padding:0 5px;color:var(--faint)"><input type="file" data-ws-upload multiple style="display:none">⤒</label>
    <span class="ws-tool" data-act="wsRefresh" title="Refresh" style="cursor:pointer;padding:0 5px;color:var(--faint)">⟳</span>
    <span class="ws">workspace</span>
  </div>
  <div class="files-body">${fileTreeHtml(s)}</div>`;
}

function garyPane(s) {
  const d = DOCK[s.surface] || {};
  return `
  <div class="comp-subhead"><span class="sub">· ${esc(d.sub || '')}</span></div>
  <div class="gary-dock">
    <div class="row">
      <div class="gav"><img src="${AVATAR}" alt="Gary"></div>
      <div style="min-width:0">
        <p>${esc(d.msg || '')}</p>
        <div class="gary-chips"><span class="gary-chip teal occhip">${esc(d.c1 || '')}</span><span class="gary-chip occhip">${esc(d.c2 || '')}</span></div>
      </div>
    </div>
  </div>
  <div class="gary-ask"><div class="box"><span class="ph">Ask Gary…</span><button class="btn-send-xs">${I.send(15)}</button></div></div>`;
}

function splitPane(s) {
  return `
  <div class="comp-split-top">
    <div class="comp-split-head">${icon('<path d="m4 17 6-6-6-6M12 19h8"/>', { size: 13, sw: 1.9, stroke: 'var(--gold)' })}<span class="t">Terminal</span><span class="s">· this chat</span></div>
    <div class="term-body" data-term-mount></div>
  </div>
  <div class="comp-split-bottom">
    <div class="comp-split-head">${I.folder(13)}<span class="t">Files</span><span class="s">· workspace</span></div>
    <div class="files-body">${fileTreeHtml(s, { dense: true })}</div>
  </div>`;
}

export function renderCompanion(s) {
  const tab = effectiveTab(s);
  const showGary = s.surface !== 'chat';
  const split = s.compSplit;
  const tabCls = (t) => `comp-tab ocbtn${(!split && tab === t) ? ' active' : ''}`;

  let body;
  if (split) body = splitPane(s);
  else if (tab === 'terminal') body = TERM_SUBHEAD + TERM_BODY;
  else if (tab === 'files') body = filesPane(s);
  else body = garyPane(s);

  return `
  <div class="companion">
    <div class="grab"></div>
    <div class="comp-tabs">
      <button class="${tabCls('terminal')}" data-act="compTab" data-arg="terminal">${I.terminal()}Terminal</button>
      <button class="${tabCls('files')}" data-act="compTab" data-arg="files">${I.folder(14, 'currentColor')}Files</button>
      ${when(showGary, `<button class="${tabCls('gary')} gary" data-act="compTab" data-arg="gary"><span class="gicon"><img src="${AVATAR}" alt=""></span>Gary</button>`)}
      <div class="oc-spacer"></div>
      <button class="comp-ctl${split ? ' on' : ''}" data-act="toggleSplit" title="Split — terminal over files">${I.split()}</button>
      <button class="comp-ctl ocbtn" data-act="toggleComp" title="Hide panel">${I.panelHide()}</button>
    </div>
    ${body}
  </div>`;
}

export function renderReveal(s) {
  const showGary = s.surface !== 'chat';
  return `
  <div class="comp-reveal">
    <button class="reveal-btn ocbtn" data-act="toggleComp" title="Show panel">${I.panelShow()}</button>
    <div class="reveal-div"></div>
    <button class="reveal-icon ocbtn" data-act="compTab" data-arg="terminal" title="Terminal">${I.terminal(16)}</button>
    <button class="reveal-icon ocbtn" data-act="compTab" data-arg="files" title="Files">${I.folder(16, 'currentColor')}</button>
    ${when(showGary, `<button class="reveal-icon ocbtn" data-act="compTab" data-arg="gary" title="Gary"><span class="reveal-gicon"><img src="${AVATAR}" alt=""></span></button>`)}
  </div>`;
}
