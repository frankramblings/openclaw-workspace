// Mobile bottom sheets: the swipe-up companion (Terminal/Files over Chat) and
// the quick-capture modal (the ➕ tab — a mobile-only surface).

import { I, icon, fortress } from '../icons.js';
import { esc, map, when, stripMd } from '../dom.js';
import { AVATAR, EXT_COLOR } from '../data.js';
import { CAPTURE_TYPES, CAPTURE_PARSE, RECENT_CAPTURES } from './mobile-data.js';

// compact file tree (shared FS data) for the companion sheet's Files tab
function fileTree(s) {
  const tree = s.live?.companion?.tree || [];
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
        rows.push(`<div class="fs-file ocfile" data-act="wsOpenFile" data-arg="${esc(path)}" style="padding-left:${pad + 17}px;padding-right:14px;cursor:pointer">${I.file(13, EXT_COLOR[node.t] || 'var(--mut)')}<span class="nm">${esc(node.n)}</span></div>`);
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

// Email compose/reply sheet. Bound to the same state + handlers the desktop
// overlay uses (composeTo/Subject/Body → sendEmail). Opened by the reader's
// AI-reply / Draft / reply-bar buttons; without this sheet those fired silently
// because only the desktop rendered a compose surface.
export function renderComposeSheet(s) {
  const busy = !!s.emailBusy;
  return `
  <div class="m-scrim" data-act="closeCompose"></div>
  <div class="m-sheet compose">
    <div class="m-grab"><div class="h"></div></div>
    <div class="m-cap-head"><span class="t">${s.composeInReplyTo ? 'Reply' : 'New message'}</span><div class="m-spacer"></div><button class="cancel" data-act="closeCompose">Cancel</button></div>
    <div class="m-compose-fields">
      <input class="m-compose-in" data-model="composeTo" data-focus="composeTo" placeholder="To" value="${esc(s.composeTo || '')}" autocomplete="off" inputmode="email">
      <input class="m-compose-in" data-model="composeSubject" data-focus="composeSubject" placeholder="Subject" value="${esc(s.composeSubject || '')}" autocomplete="off">
      <textarea class="m-compose-body" data-model="composeBody" data-focus="composeBody" rows="7" placeholder="Write your message…">${esc(s.composeBody || '')}</textarea>
    </div>
    <button class="m-cap-send" data-act="sendEmail"${busy ? ' disabled' : ''}>${busy ? 'Sending…' : `${I.send(17)}Send`}</button>
  </div>`;
}

// Shared conversation list markup — used by the edge-swipe side drawer (and the
// legacy bottom sheet). One row per session; tapping selects, swiping the drawer
// away dismisses it.
function convListHtml(s) {
  const chat = s.live?.chat || {};
  const allGroups = chat.groups || [];
  const q = (s.convFilter || '').trim().toLowerCase();
  // Local title filter (instant); semantic content hits are appended below.
  const groups = q
    ? allGroups.map((g) => ({ ...g, rows: (g.rows || []).filter((r) => String(r.title || '').toLowerCase().includes(q)) })).filter((g) => g.rows.length)
    : allGroups;
  const convRow = (r) => `<div class="m-conv-row ocrow${r.active ? ' active' : ''}" data-act="mSelectSession" data-arg="${esc(r.id)}">
    <span class="m-conv-badge${r.term ? ' term' : ''}">${r.term ? '∿' : 'A\\'}</span>
    <span class="m-conv-title">${esc(r.title)}</span>
    ${r.notify ? `<span class="m-conv-dot notify" title="Reply finished"></span>`
      : r.working ? `<span class="m-conv-spin working" title="Working…">${fortress(14)}</span>`
      : r.active ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
  </div>`;
  const titleHtml = map(groups, (g) => `<div class="m-conv-grp">${esc(g.label)}</div>${map(g.rows || [], convRow)}`);
  const msgHtml = mConvSemanticHits(s, groups);
  if (!allGroups.length) return '<div style="padding:16px;color:var(--faint);font-size:13px">No conversations yet.</div>';
  if (q && !groups.length && !msgHtml) return '<div style="padding:16px;color:var(--faint);font-size:13px">No conversations match.</div>';
  return titleHtml + msgHtml;
}

// Semantic content matches (backend /api/search) for the mobile conv drawer —
// mirrors the desktop MESSAGES section. Skips sessions already shown as a title
// match. Tapping a hit opens that conversation.
function mConvSemanticHits(s, titleGroups) {
  const chat = s.live && s.live.chat;
  const q = (s.convFilter || '').trim();
  if (!chat || q.length < 2) return '';
  const label = '<div class="m-conv-grp">MESSAGES</div>';
  const res = chat.searchResults;
  if (chat.searchLoading && !Array.isArray(res)) {
    return `${label}<div style="padding:8px 16px;color:var(--faint);font-size:12px">Searching…</div>`;
  }
  if (!Array.isArray(res)) return '';
  const shown = new Set((titleGroups || []).flatMap((g) => (g.rows || []).map((r) => r.id)));
  const seen = new Set();
  const rows = [];
  for (const r of res) {
    if (!r || !r.session_id || shown.has(r.session_id) || seen.has(r.session_id)) continue;
    seen.add(r.session_id);
    rows.push(r);
  }
  if (!rows.length) return '';
  const hitRow = (r) => `<div class="m-conv-row ocrow m-conv-msghit" data-act="mSelectSession" data-arg="${esc(r.session_id)}">
    <span class="m-conv-badge">A\\</span>
    <span class="m-conv-hit"><span class="m-conv-title">${esc(r.session_name || 'Conversation')}</span><span class="m-conv-hit-snip">${esc(stripMd(r.content_snippet || ''))}</span></span>
  </div>`;
  return label + map(rows, hitRow);
}

// Edge-swipe conversation drawer. Always present in the DOM (translated off the
// active edge when closed) so wireMobileGestures can finger-track it open/closed
// without a mid-touch innerHTML rebuild. `mDrawerSide` picks which edge it hugs.
export function renderConvDrawer(s) {
  const side = s.mDrawerSide === 'right' ? 'right' : 'left';
  const open = !!s.mDrawerOpen;
  return `
  <div class="m-drawer-scrim${open ? ' open' : ''}" data-act="closeDrawer"></div>
  <div class="m-drawer ${side}${open ? ' open' : ''}" data-conv-drawer role="dialog" aria-label="Conversations">
    <div class="m-drawer-head"><span class="t">Conversations</span><div class="m-spacer"></div><button class="m-round-btn" data-act="mNewChat" title="New chat">${I.plus(16)}</button><button class="cancel" data-act="closeDrawer">Close</button></div>
    <div class="m-drawer-search">${I.search()}<input data-model="convFilter" data-focus="convFilter" placeholder="Search all conversations…" value="${esc(s.convFilter || '')}" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"></div>
    <div class="m-conv-list" data-ptr-skip>${convListHtml(s)}</div>
  </div>`;
}

export function renderConvSheet(s) {
  return `
  <div class="m-scrim" data-act="closeConvSheet"></div>
  <div class="m-sheet conv-sheet">
    <div class="m-grab"><div class="h"></div></div>
    <div class="m-cap-head"><span class="t">Conversations</span><div class="m-spacer"></div><button class="m-round-btn" data-act="newChat" title="New chat">${I.plus(16)}</button><button class="cancel" data-act="closeConvSheet">Close</button></div>
    <div class="m-conv-list">${convListHtml(s)}</div>
  </div>`;
}

export function renderModelSheet(s) {
  const chat = s.live?.chat || {};
  const groups = s.live?.modelGroups || [];
  const curId = (chat.endpointId || '') + '·' + (chat.model || '');
  const defId = s.live?.defaultModel || '';
  if (!groups.length) {
    return `<div class="m-scrim" data-act="closeModelSheet"></div><div class="m-sheet model-sheet"><div class="m-grab"><div class="h"></div></div><div class="m-cap-head"><span class="t">Model</span><div class="m-spacer"></div><button class="cancel" data-act="closeModelSheet">Close</button></div><div style="padding:20px;color:var(--faint);font-size:13px">Loading models…</div></div>`;
  }
  const row = (m) => {
    const active = m.id === curId;
    const isDef = m.id === defId;
    return `<div class="m-model-row${active ? ' sel' : ''}" data-act="mSetModel" data-arg="${esc(m.id)}">
      <span class="m-model-name">${esc(m.name)}</span>
      ${active ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      <span class="mstar${isDef ? ' mstar-def' : ''}" data-act="mSetDefaultModel" data-arg="${esc(m.id)}" title="Set as default">★</span>
    </div>`;
  };
  const group = (g) => `<div class="m-model-ep">${esc(g.ep)}</div>${map(g.models, row)}`;
  return `
  <div class="m-scrim" data-act="closeModelSheet"></div>
  <div class="m-sheet model-sheet">
    <div class="m-grab"><div class="h"></div></div>
    <div class="m-cap-head"><span class="t">Model</span><div class="m-spacer"></div><button class="cancel" data-act="closeModelSheet">Close</button></div>
    <div class="m-model-list">${map(groups, group)}</div>
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
    <div class="m-cap-head"><div class="av"><img src="${AVATAR}" alt="__AGENT_NAME__"></div><span class="t">Quick capture</span><div class="m-spacer"></div><button class="cancel" data-act="closeCapture">Cancel</button></div>
    <div class="m-cap-input"><textarea data-model="captureDraft" data-focus="mcapture" rows="2" placeholder="Remind me to send the Cannes deck to legal before Friday">${esc(draft)}</textarea></div>
    ${when(draft.trim().length > 0, `<div class="m-cap-parse"><span class="k">__AGENT_NAME__ parsed:</span>${esc(parse)}</div>`)}
    <div class="m-cap-types">
      ${map(CAPTURE_TYPES, (t) => `<span class="m-cap-type${type === t.id ? ' active' : ''}" data-act="setCaptureType" data-arg="${t.id}">${t.glyph} ${esc(t.label)}</span>`)}
    </div>
    <button class="m-cap-send" data-act="sendCapture">${I.send(17)}Send to __AGENT_NAME__</button>
    <div class="m-cap-recent-lbl">RECENT CAPTURES</div>
    ${map(RECENT_CAPTURES, (r) => `<div class="m-cap-recent"><span class="g" style="color:${r.color}">${r.glyph}</span><span class="tx">${esc(r.text)}</span><span class="ty">${esc(r.type)}</span></div>`)}
  </div>`;
}
