// Per-surface center renderers for the redesign shell.
// Each returns an HTML string; interactivity is wired via data-act / data-model
// attributes handled by app.js event delegation.

import { I, icon, fortress } from './icons.js';
import { esc, map, when, stripMd } from './dom.js';
import { cardActions, filterVisible, sourceCounts, cardButtonsHtml, chipRowHtml, entityView, triageSummary, triageSummaryText, bodyIsPath, pointerRefLabel } from './live/inbox-logic.js';
import { detailEndpoint } from './live/inbox-detail.js';
import { questionCardHtml } from './live/question-card.js';
import {
  AVATAR, filterSlashCommands, RESEARCH_CONTROLS,
  KIND_STYLE, LIB_FILTERS, CAL_BAR_TONE,
} from './data.js';
import { TAB, PANELS, NAV_GROUPS } from './settings-data.js';
import { renderActivity } from './chat-activity.js';
import { suggestGhost } from './suggest-ghost.js';
import './task-rows.js'; // side-effect: boots the feed subscription and injects live rows
import { renderMarkdown } from './markdown.js';
import { renderWithMentionChips } from './mention-core.js';
import { providerLogo } from './provider-logo.js';
import { renderChatStrip } from './chat-strip.js';
import { renderSwitcher } from './switcher.js';
import { steerComposerHints, steerCaptionHtml } from './steer-view.js';
import { moveMenuHtml, projectName, parentTitle } from './project-menu.js';
import { usageLine, usageTitle, sessionTotalsLine } from './usage-view.js';
import { usagePanelHtml } from './usage-panel.js';
import { changesCardHtml } from './changes-view.js';
import { changesSettingsHtml } from './changes-settings.js';
// Fetch caps for the task-6.2 "showing first N" disclosure footer (capNotice,
// below). NOT imported from the live/*.js modules that own them — every
// live/*.js file eventually imports api.js, which reads `location.origin` at
// MODULE TOP LEVEL; surfaces.js is a pure renderer with no other live-module
// dependency and stays importable before `location` exists (several tests
// rely on exactly that). Kept in sync by hand — each value is mirrored from
// its live module's own exported CAP (see the comment at each site).
// Exported (INBOX_CAP/EMAIL_CAP) so mobile-surfaces.js's separate mInbox/
// mEmailList renderers can share the same value instead of a third copy.
export const INBOX_CAP = 200;    // live/inbox.js CAP
export const EMAIL_CAP = 50;     // live/email.js CAP
const LIBRARY_CAP = 30;   // live/library.js CAP
const RESEARCH_CAP = 20;  // live/research.js CAP

// ===========================================================================
// SHARED — load-failure partial
// ===========================================================================
// Task 2.1: failure state ≠ empty state. Every data surface (inbox, email,
// calendar, notes, library, research) checks state.loadError[key] BEFORE
// deciding what "no content" means — a fetch that threw is not the same as a
// fetch that legitimately came back empty, and showing celebratory/neutral
// empty copy for the former was actively misleading. Retry clears the
// surface's fetchedOnce flag and re-runs its loader (see live/index.js's
// retrySurface action / reload()). surfaceLabel doubles as the retry key —
// lowercased, it already matches live/index.js's MODULES keys ('Inbox' →
// 'inbox', 'Email' → 'email', …). Mobile has its own mLoadErrorBlock in
// mobile-surfaces.js (kept separate — its empty-state visual language is
// compact/centered where desktop's is a wide flex block; sharing one class
// across both would fight one shell or the other).
//
// Fix round 1, finding 5: the optional state `s` arg lets the Retry button
// reflect state.retrying[key] (set by live/index.js while a (re)load for
// this surface is in flight) — disabled + a spinner label instead of a
// clickable "Retry" a second tap could re-trigger before the first attempt
// even resolves.
export function loadErrorBlock(surfaceLabel, s) {
  const key = String(surfaceLabel || '').toLowerCase();
  const retrying = !!(s && s.retrying && s.retrying[key]);
  return `<div class="load-error-block cal-empty" style="flex-direction:column;gap:10px;padding:40px 20px;text-align:center">
    <div>Couldn't load ${esc(surfaceLabel)}.</div>
    <button class="btn-sm" data-act="retrySurface" data-arg="${esc(key)}"${retrying ? ' disabled' : ''}>${retrying ? `${fortress(12)} Retrying…` : 'Retry'}</button>
  </div>`;
}

// Task 6.1: small manual-refresh button for a surface header — reuses the
// SAME retrySurface plumbing as the error-state Retry button above (data-act
// + state.retrying spinner state), just available from a healthy header too.
// The visibility/focus freshness sweep in live/index.js already refetches a
// surface once its data turns 60s+ stale; this covers "I want it now".
function refreshBtn(key, s) {
  const retrying = !!(s && s.retrying && s.retrying[key]);
  return `<button type="button" class="icon-btn ocbtn" data-act="retrySurface" data-arg="${esc(key)}" title="Refresh" aria-label="Refresh"${retrying ? ' disabled' : ''}>${retrying ? fortress(14) : I.refresh(14)}</button>`;
}

// Task 6.2: every capped list endpoint (see each live/*.js module's exported
// CAP) can silently hide real data once a fetch lands exactly at the cap —
// there's no way for the UI to tell "that's everything" from "there's more,
// we just didn't ask for it". No pagination build here, disclosure only: a
// plain footer line when length === cap. Exported so mobile-surfaces.js's
// separate mInbox/mEmailList renderers can share it (library/research reuse
// THIS module's renderers wholesale via mobile-app.js's pushedSurface, so
// they get the footer for free and need no separate mobile call).
export function capNotice(len, cap) {
  return len === cap
    ? `<div style="padding:10px 4px 2px;color:var(--faint);font-size:12px;text-align:center">Showing first ${cap} — refine to see more</div>`
    : '';
}

// ===========================================================================
// CHAT
// ===========================================================================
export function renderChatList(s) {
  return `
  <div class="oc-secondary chat-list">
    <div class="chat-list-top">
      <button class="new-conv" data-act="newChat" title="New conversation (⌘⇧O / Ctrl+Shift+O)"><span class="plus">+</span> New conversation</button>
      <div class="oc-search" style="margin-top:10px">${I.search()}<input data-model="convFilter" data-focus="convFilter" placeholder="Search all conversations…" value="${esc(s.convFilter || '')}" autocomplete="off" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg);font-family:inherit"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:6px"><button data-act="cycleSessionSort" title="Sort order" style="background:none;border:none;color:var(--faint);font-size:11px;cursor:pointer">${s.convSort === 'alpha' ? 'A–Z' : 'Recent'} ⇅</button></div>
    </div>
    <div class="conv-scroll">${convListBody(s)}</div>
    <div class="conv-foot">${esc(s.live?.chat?.cwd ?? '/home/frank/.openclaw/workspace')}</div>
  </div>`;
}

// Per-row conversation actions menu (5 items). Rendered inline when this row's
// menu is open. The wrapper's data-act="noop" swallows clicks on menu chrome so
// they neither select the row nor close the menu.
function convMenu(r, s) {
  const fav = r.important ? 'Unfavorite' : 'Favorite';
  const item = (act, glyph, label, extra = '') =>
    `<button class="cm-item${extra}" data-act="${act}" data-arg="${esc(r.id)}" role="menuitem"><span class="cm-ic">${glyph}</span>${label}</button>`;
  return `<div class="conv-menu" data-act="noop" role="menu">`
    + item('renameSession', I.pencil(14), 'Rename')
    + item('toggleFavorite', I.star(14, !!r.important), fav)
    + item('copyTranscript', I.copy(14), 'Copy chat')
    + item('archiveSession', I.archive(14), 'Archive')
    + item('deleteSession', I.trash(14), 'Delete', ' cm-danger')
    + moveMenuHtml(r.id, s.live?.projects || [], r.folder, esc)
    + `</div>`;
}

// conversation rows: live sessions (grouped) with mock fallback
function convListBody(s) {
  const groups = s.live?.chat?.groups; // [{ label, rows:[{id,title,glyph,term,active}] }]
  if (!groups) {
    return `
      <div class="conv-group top"><span class="sect-label">TODAY</span></div>
      <div class="conv-row active"><span class="conv-badge">G</span><span class="conv-title">Workspace Streaming Chat</span></div>
      <div class="conv-row ocrow"><span class="conv-badge">G</span><span class="conv-title">Comedy Show Misogyny Check</span></div>
      <div class="conv-row ocrow"><span class="conv-badge">G</span><span class="conv-title">help me organize these thoughts</span></div>
      <div class="conv-group"><span class="sect-label">YESTERDAY</span></div>
      <div class="conv-row ocrow"><span class="conv-badge">G</span><span class="conv-title">Punny Names for OpenClaw</span></div>
      <div class="conv-row ocrow"><span class="conv-badge term">∿</span><span class="conv-title">Install Codex on Ubuntu</span></div>`;
  }
  const q = (s.convFilter || '').trim().toLowerCase();
  const groups2 = q
    ? groups.map((g) => ({ ...g, rows: (g.rows || []).filter((r) => String(r.title || '').toLowerCase().includes(q)) })).filter((g) => g.rows.length)
    : groups;
  // Alpha sort now sorts within each section (spec 7.1) instead of flattening
  // the date groups into a single A–Z list.
  const alpha = (rows) => rows.slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
  const sorted = s.convSort === 'alpha' ? groups2.map((g) => ({ ...g, rows: alpha(g.rows || []) })) : groups2;
  const rowMenuOpen = s.live?.chat?.rowMenuOpen;
  const convRow = (r) => {
    const rowLogo = r.term ? '' : (providerLogo(r.endpointId, r.model) || '');
    const badgeInner = r.term ? '∿' : (rowLogo || 'G');
    const badgeClass = 'conv-badge' + (r.term ? ' term' : '') + (rowLogo ? ' provider' : '');
    return `<div class="conv-row${r.active ? ' active' : ' ocrow'}${rowMenuOpen === r.id ? ' menu-open' : ''}${r.depth ? ` depth${r.depth}` : ''}" data-act="selectSession" data-arg="${esc(r.id)}" draggable="true" data-drag-session="${esc(r.id)}">`
    + `<span class="${badgeClass}">${badgeInner}</span>`
    + `<span class="conv-title">${esc(r.title)}</span>`
    + (r.notify ? `<span class="conv-dot notify" title="Reply finished"></span>`
        : r.working ? `<span class="conv-spin working" title="Working…">${fortress(15)}</span>`
        : r.queued ? `<span class="conv-dot queued" title="Message queued — sends when the reply finishes"></span>` : '')
    + (r.important ? `<span class="conv-fav" aria-hidden="true">${I.star(13, true)}</span>` : '')
    + (r.slot ? `<span class="conv-slot" title="Option+${r.slot}">⌥${r.slot}</span>` : '')
    + (r.slot ? `<button class="conv-close" data-act="closeOpen" data-arg="${esc(r.id)}" title="Remove from Open" aria-label="Remove from Open">${I.x(12)}</button>` : '')
    + `<button class="conv-kebab" data-act="toggleConvMenu" data-arg="${esc(r.id)}" title="Conversation actions" aria-label="Conversation actions">${I.dots(15)}</button>`
    + (rowMenuOpen === r.id ? convMenu(r, s) : '')
    + `</div>`;
  };
  const header = (g, gi) => {
    const top = gi === 0 ? ' top' : '';
    if (g.kind === 'open') {
      // Amendment D: while filtering, the count reflects what's actually
      // rendered (post-filter rows), not the unfiltered meta count.
      const count = q ? g.rows.length : g.meta.count;
      return `<div class="conv-group open${top}"><span class="sect-label">OPEN</span><span class="sect-count">${count}</span></div>`;
    }
    if (g.kind === 'project') {
      const m = g.meta;
      // Amendment D: a filter match inside a collapsed project must not stay
      // hidden, so filtering forces every project group open and its count
      // to the number of rows actually shown.
      const collapsed = q ? false : m.collapsed;
      const count = q ? g.rows.length : m.count;
      const menuOpen = s.live?.chat?.projMenuOpen === m.id;
      return `<div class="conv-group project${top}${collapsed ? ' collapsed' : ''}${menuOpen ? ' menu-open' : ''}" data-act="toggleProject" data-arg="${esc(m.id)}" data-proj-anchor="${esc(m.id)}" role="button" tabindex="0" aria-expanded="${!collapsed}">`
        + `<span class="proj-chev">▸</span>`
        + `<span class="sect-label proj-name">${esc(g.label)}</span>`
        + `<span class="sect-count">${count}</span>`
        + (m.working ? `<span class="proj-pip working" title="${m.working} working">${fortress(12)}${m.working}</span>` : '')
        + (m.unseen ? `<span class="proj-pip unseen" title="${m.unseen} finished while away"><span class="conv-dot notify"></span>${m.unseen}</span>` : '')
        + `<button class="conv-kebab proj-kebab" data-act="toggleProjMenu" data-arg="${esc(m.id)}" title="Project actions" aria-label="Project actions">${I.dots(15)}</button>`
        + (menuOpen
          ? `<div class="conv-menu proj-menu" data-act="noop" role="menu">`
            + `<button class="cm-item" data-act="renameProject" data-arg="${esc(m.id)}" role="menuitem"><span class="cm-ic">${I.pencil(14)}</span>Rename</button>`
            + `<button class="cm-item" data-act="archiveProject" data-arg="${esc(m.id)}" role="menuitem"><span class="cm-ic">${I.archive(14)}</span>Archive project</button>`
            + `</div>`
          : '')
        + `</div>`;
    }
    return `<div class="conv-group${top}"><span class="sect-label">${esc(g.label)}</span></div>`;
  };
  const titleHtml = map(sorted, (g, gi) => header(g, gi) + ((g.kind === 'project' && g.meta.collapsed && !q) ? '' : map(g.rows, convRow)));
  const msgHtml = semanticHits(s, groups2);
  if (q && !groups2.length && !msgHtml) return '<div class="conv-empty" style="padding:14px;color:var(--faint);font-size:13px">No conversations match.</div>';
  return titleHtml + msgHtml;
}

// Semantic content matches (backend /api/search) rendered as a MESSAGES section
// beneath the local title matches. Surfaces conversations whose MESSAGE CONTENT
// is relevant even when the title has none of the query words — and reaches
// every conversation, not just the ones the list has loaded. Sessions already
// shown as a title match are skipped to avoid duplicate rows.
function semanticHits(s, titleGroups) {
  const chat = s.live && s.live.chat;
  const q = (s.convFilter || '').trim();
  if (!chat || q.length < 2) return '';
  const label = '<div class="conv-group"><span class="sect-label">MESSAGES</span></div>';
  const res = chat.searchResults;
  if (chat.searchLoading && !Array.isArray(res)) {
    return `${label}<div class="conv-empty" style="padding:10px 14px;color:var(--faint);font-size:12px">Searching…</div>`;
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
  const hitRow = (r) => `<div class="conv-row ocrow conv-msghit" data-act="selectSession" data-arg="${esc(r.session_id)}">`
    + `<span class="conv-badge">G</span>`
    + `<span class="conv-hit"><span class="conv-title">${esc(r.session_name || 'Conversation')}</span>`
    + `<span class="conv-hit-snip">${esc(stripMd(r.content_snippet || ''))}</span></span>`
    + `</div>`;
  return label + map(rows, hitRow);
}

// Per-message hover toolbar: client-side Copy + Download, bound to the message id.
// Download expands to a small flyout offering Markdown or PDF.
function msgTools(m, openId, ctx) {
  const open = openId === m.id;
  const canEdit = !!(ctx && ctx.canEdit && m.role === 'user');
  const menu = open
    ? `<div class="msg-dl-menu" data-act="noop" role="menu">`
        + `<button class="msg-dl-item" data-act="downloadMessage" data-arg="${esc(m.id)}" role="menuitem"><span class="msg-dl-ic">${I.download(13)}</span>Markdown</button>`
        + `<button class="msg-dl-item" data-act="downloadMessagePDF" data-arg="${esc(m.id)}" role="menuitem"><span class="msg-dl-ic">${I.download(13)}</span>PDF</button>`
      + `</div>`
    : '';
  // Speak (read aloud in Gary's voice) — assistant messages only. Three states:
  // synthesizing (fortress spinner), playing (tap to stop), idle (tap to play).
  let speak = '';
  if (m.role === 'assistant') {
    if (ctx && ctx.loadId === m.id) {
      speak = `<button class="msg-tool is-speaking" data-act="stopSpeak" data-arg="${esc(m.id)}" title="Synthesizing…" aria-label="Synthesizing">${fortress(15)}</button>`;
    } else if (ctx && ctx.speakId === m.id) {
      speak = `<button class="msg-tool is-speaking" data-act="stopSpeak" data-arg="${esc(m.id)}" title="Stop" aria-label="Stop reading">${I.stopSpeak(15)}</button>`;
    } else {
      speak = `<button class="msg-tool" data-act="speakMessage" data-arg="${esc(m.id)}" title="Read aloud" aria-label="Read aloud">${I.speak(15)}</button>`;
    }
  }
  return `<div class="msg-tools">`
    + speak
    + `<button class="msg-tool" data-act="copyMessage" data-arg="${esc(m.id)}" title="Copy message" aria-label="Copy message">${I.copy(15)}</button>`
    + `<button class="msg-tool" data-act="branchFromMessage" data-arg="${esc(m.id)}" title="Branch conversation here" aria-label="Branch here">${I.branch(15)}</button>`
    + (canEdit
        ? `<button class="msg-tool" data-act="editMessage" data-arg="${esc(m.id)}" title="Edit message" aria-label="Edit">${I.edit(15)}</button>`
        : '')
    + `<div class="msg-dl-wrap">`
      + `<button class="msg-tool${open ? ' on' : ''}" data-act="toggleMsgMenu" data-arg="${esc(m.id)}" title="Download message" aria-label="Download message" aria-haspopup="menu" aria-expanded="${open}">${I.download(15)}</button>`
      + menu
    + `</div>`
    + `</div>`;
}

function renderAttachments(attach) {
  if (!attach || !attach.length) return '';
  const items = attach.map((a) => {
    const isImg = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(a.name || '');
    if (isImg && a.url) return `<img class="msg-attach-img" src="${esc(a.url)}" alt="${esc(a.name || 'image')}">`;
    return `<span class="msg-attach-chip">📎 ${esc(a.name || a.id)}</span>`;
  }).join('');
  return `<div class="msg-attachments">${items}</div>`;
}

// Interleaved rendering for history turns: round_texts[0] → mini-trail for
// round 1 tools → round_texts[1] → mini-trail for round 2 tools → …
// Each tool group uses a scoped id so collapse state doesn't collide.
function renderRounds(m, s) {
  const rawRts = m.round_texts;
  const byRound = {};
  (m.activity.steps || []).forEach(st => {
    const r = st.round || 1;
    (byRound[r] = byRound[r] || []).push(st);
  });
  const maxRound = Object.keys(byRound).reduce((mx, r) => Math.max(mx, +r), 0);
  let html = '';
  const rt0 = rawRts[0];
  if (rt0 && rt0.trim()) html += `<div class="rnd-txt">${renderMarkdown(rt0)}</div>`;
  for (let r = 1; r <= maxRound; r++) {
    const rSteps = byRound[r] || [];
    if (rSteps.length) {
      html += renderActivity({ id: `${m.id}-r${r}`, activity: { status: 'done', steps: rSteps } }, s);
    }
    const rt = rawRts[r];
    if (rt && rt.trim()) html += `<div class="rnd-txt">${renderMarkdown(rt)}</div>`;
  }
  return html;
}

// one chat message → html (assistant prose / user bubble). Live thread items:
// { role:'assistant'|'user', time, model, text, activity? }
export function chatMsg(m, s, ghostCtx) {
  const hasText = String(m.text || '').trim().length > 0;
  // Mention tokens in a sent user message render as chips, never as the
  // markdown renderer's dead link (its scheme is rejected by safeUrl, so the
  // token used to show up as an anchor that opens a blank tab).
  const paras = hasText ? renderMarkdown(m.text) : '';
  const carriedCls = m._carried ? ` msg-carried${m._carriedFirst ? ' msg-carried-first' : ''}` : '';
  if (m.role === 'user' && m.sys) {
    return `<div class="msg-sys${carriedCls}" data-msg-id="${esc(m.id)}"><span class="msg-sys-txt">${esc(m.text)}</span></div>`;
  }
  if (m.role === 'user') {
    const attachHtml = renderAttachments(m.attach);
    const canEdit = !!(s.live?.chat?.pendingSend && s.live.chat.pendingSend.messageId === m.id);
    const ctx = { canEdit };
    // Inline editor (Task 8): app.js's editMessage sets chat.editingId rather
    // than touching the DOM directly, because every action dispatch is
    // followed by a full render() that rebuilds root.innerHTML wholesale —
    // any manual DOM swap would be wiped the instant the click handler
    // returns. So the textarea + Save/Cancel bar is template output, gated on
    // state, same as everything else here.
    if (canEdit && s.live?.chat?.editingId === m.id) {
      const val = s.editDraft != null ? s.editDraft : m.text;
      const rows = Math.max(2, String(val || '').split('\n').length + 1);
      return `<div class="msg-user-wrap${carriedCls}" data-msg-id="${esc(m.id)}"><div class="msg-user msg-editing">`
        + `<textarea class="msg-edit-ta" data-model="editDraft" data-focus="msgEdit" rows="${rows}">${esc(val || '')}</textarea>`
        + `<div class="msg-edit-bar">`
          + `<button class="msg-edit-cancel ocbtn" data-act="cancelEdit" data-arg="${esc(m.id)}">Cancel</button>`
          + `<button class="msg-edit-save ocbtn" data-act="saveEdit" data-arg="${esc(m.id)}">Save &amp; send</button>`
        + `</div>`
      + `</div></div>`;
    }
    // While the 700ms send-buffer is armed (Task 7), a small ring next to the
    // timestamp drains as the deadline approaches — the visible countdown
    // before this bubble actually hits the gateway. The drain itself is a
    // pure CSS animation (see .msg-pending-ring / @keyframes ring-drain in
    // redesign.css) driven off this element's own mount time — no per-frame
    // JS render loop needed, so it never competes with the surgical-patch
    // rendering the rest of chat.js relies on.
    // Mention tokens in a sent user message render as chips, never as the
    // markdown renderer's dead link (safeUrl rejects the note:/doc: scheme, so
    // the token used to show as an anchor that opens a blank tab).
    const userParas = hasText ? renderWithMentionChips(m.text, renderMarkdown) : '';
    let pendingRing = '';
    if (m._optimistic && m._deadline) {
      const remaining = Math.max(0, m._deadline - Date.now());
      pendingRing = `<span class="msg-pending-ring" title="Sending in ${Math.ceil(remaining / 100) / 10}s — edit to change it"></span>`;
    }
    return `<div class="msg-user-wrap${carriedCls}" data-msg-id="${esc(m.id)}"><div class="msg-user"><div class="meta"><span class="time">${esc(m.time || '')}</span>${pendingRing}<span class="you">You</span></div>${attachHtml}${userParas || (attachHtml ? '' : '<p></p>')}${steerCaptionHtml(m)}</div>${hasText ? msgTools(m, s.live?.chat?.msgMenuOpen, ctx) : ''}</div>`;
  }
  // Empty/failed turn safeguard: when a turn produced no text and no tool work
  // (e.g. the model isn't served on this plan, or the request errored), show an
  // explicit notice instead of a silent blank bubble. See live/chat.js onEvent.
  const notice = m.error
    ? `<div class="msg-error" style="margin-top:6px;display:flex;gap:7px;align-items:flex-start;color:var(--red,#e5616a);font-size:13px;line-height:1.45;background:rgba(229,97,106,.08);border:1px solid rgba(229,97,106,.28);border-radius:8px;padding:8px 11px"><span aria-hidden="true">⚠</span><span>${esc(m.notice || 'No response from this model.')}</span></div>`
    : '';
  const warn = (!m.error && m.warnNotice)
    ? `<div class="msg-warn" style="margin-top:6px;display:flex;gap:7px;align-items:flex-start;color:var(--amber,#d8a24a);font-size:13px;line-height:1.45;background:rgba(216,162,74,.08);border:1px solid rgba(216,162,74,.28);border-radius:8px;padding:8px 11px"><span aria-hidden="true">⚠</span><span>${esc(m.warnNotice)}</span></div>`
    : '';
  // Tappable AskUserQuestion card (set on the live tool_start path by
  // chat.js's buildQuestionCardModel). Locked/choice/selections live on the
  // message model so state survives the wholesale innerHTML re-render.
  const questionCard = m.questionCard
    ? questionCardHtml(m.questionCard.model, esc, {
        locked: !!m.questionCard.locked,
        choice: m.questionCard.choice || '',
        selections: m.questionCard.selections || [],
        toolId: m.questionCard.toolId || '',
      })
    : '';
  const bodyHtml = (m.round_texts && m.round_texts.length > 1 && m.activity && !m.error)
    ? renderRounds(m, s) : `${renderActivity(m, s)}${paras}`;
  const streamAttr = m.streaming ? ' data-streaming="1"' : '';
  const _chat = s.live?.chat || {};
  const asstCtx = { canEdit: false, speakId: _chat.speakingId, loadId: _chat.speakLoadingId };
  // Pending-work update blocks (resolved deferred tasks, e.g. image_generate).
  const updateBlocksHtml = (() => {
    const blocks = m.updateBlocks;
    if (!Array.isArray(blocks) || !blocks.length) return '';
    return blocks.map((b) => {
      const mins = Math.max(0, Math.round((b.elapsed_ms || 0) / 60000));
      const lbl = mins < 1 ? 'just now' : `${mins}m later`;
      const hdr = `<div class="turn-update-header">↳ update, ${esc(lbl)}</div>`;
      let content = '';
      if (b.payload && b.payload.image_url) {
        content = `<img class="turn-update-image" src="${esc(b.payload.image_url)}" alt="${esc(b.payload.alt_text || '')}" onclick="window.open(this.src,'_blank')">`;
      } else if (b.payload && b.payload.error) {
        content = `<div class="turn-update-error">${esc(b.payload.error)}</div>`;
      }
      return `<div class="turn-update-block">${hdr}${content}</div>`;
    }).join('');
  })();
  // Pending-work pill: fortress spinner while any deferred work is outstanding.
  const pendingPillHtml = (() => {
    const tokens = m.pendingTokens;
    if (!Array.isArray(tokens) || !tokens.length) return '';
    const n = tokens.length;
    const title = tokens.map((t) => `${t.kind} · ${t.label}`).join('\n');
    return `<span class="turn-pending-pill" title="${esc(title)}"><span class="turn-pending-spin">${fortress(14)}</span>${n === 1 ? 'pending' : n}</span>`;
  })();
  const ghostHtml = (ghostCtx && ghostCtx.msgId === m.id) ? (ghostCtx.html || '') : '';
  const changesHtml = m.changes ? changesCardHtml(m.changes, { expanded: !!(s.live?.changes?.expanded && s.live.changes.expanded.has(m.changes.turn_id)) }) : '';
  return `<div class="msg-asst${carriedCls}" data-msg-id="${esc(m.id)}"${streamAttr}><div class="msg-av"><img src="${AVATAR}" alt="__AGENT_NAME__" decoding="sync" loading="eager"></div><div class="msg-body"><div class="msg-meta"><span class="name">__AGENT_NAME__</span>${m.model ? `<span class="model">${esc(m.model)}</span>` : ''}<span class="time">${esc(m.time || '')}</span>${(() => { const uOpts = { provider: m.provider || (m.usage && m.usage._provider) }; const line = usageLine(m.usage, null, uOpts); return line ? `<span class="usage" title="${esc((m.usage && m.usage._session ? 'session so far · ' : '') + usageTitle(m.usage, uOpts))}">${esc(line)}</span>` : ''; })()}</div>${bodyHtml}${notice}${warn}${questionCard}${updateBlocksHtml}${pendingPillHtml}${changesHtml}${hasText && !m.error ? msgTools(m, s.live?.chat?.msgMenuOpen, asstCtx) : ''}${ghostHtml}</div></div>`;
}


// Composite model identity (endpoint·model) — must match live/chat.js MODEL_SEP.
const MODEL_SEP = '·';

// The compact, endpoint-grouped model picker popover. Endpoint is named once per
// group header (the de-duplication); rows carry only the bare model name. The
// active check and gold default star key on the composite id, so the same model
// offered by two endpoints no longer co-selects. Wrapper carries data-act="noop"
// so clicks on chrome don't fall through to the outside-click close.
export function modelPopover(s) {
  const chat = (s.live && s.live.chat) || {};
  const groups = s.live && s.live.modelGroups;
  if (!groups || !groups.length) {
    return `<div class="model-pop" data-act="noop"><div class="model-empty">Loading…</div></div>`;
  }
  const curId = (chat.endpointId || '') + MODEL_SEP + (chat.model || '');
  const defId = (s.live && s.live.defaultModel) || '';
  const row = (m) => {
    const active = m.id === curId;
    const isDef = m.id === defId;
    return `<div class="model-row${active ? ' sel' : ''}" data-act="setModel" data-arg="${esc(m.id)}">`
      + `<span class="model-name">${esc(m.name)}</span>`
      + (active ? `<svg class="model-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : '')
      + `<span class="mstar${isDef ? ' mstar-def' : ''}" data-act="setDefaultModel" data-arg="${esc(m.id)}" title="Set as default for new chats">★</span>`
      + `</div>`;
  };
  const group = (g) => `<div class="model-grp"><span class="model-ep">${esc(g.ep)}</span>${g.hasTag ? `<span class="model-tag">${esc(g.tag)}</span>` : ''}</div>${map(g.models, row)}`;
  return `<div class="model-pop" data-act="noop">${map(groups, group)}<div class="model-foot">★ sets the default for new chats</div></div>`;
}

// Trigger-button label: prefer the loaded list's bare name for the current
// (endpoint·model) selection; fall back to the raw model id before the list loads.
function currentModelLabel(s, model) {
  const list = s.live && s.live.modelList;
  const chat = (s.live && s.live.chat) || {};
  if (list && list.length) {
    const curId = (chat.endpointId || '') + MODEL_SEP + (chat.model || '');
    const hit = list.find((m) => m.id === curId) || list.find((m) => m.mid === model);
    if (hit) return hit.name;
  }
  return model;
}

// Attachment chips — image files get a thumbnail, everything else gets a
// labelled card with an extension badge (mirrors Claude / ChatGPT behaviour).
const _IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','avif','ico']);
function attachChip(a) {
  const name = a.name || a.id;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const rm = `<button class="atch-rm" data-act="removeAttach" data-arg="${esc(a.id)}" title="Remove">✕</button>`;
  // Upload lifecycle (task 4.2): spinner while the POST is in flight, red +
  // removable on failure. Neither is sendable (attach-logic.uploadGate), and
  // neither has a server id yet, so no thumbnail fetch against a temp id.
  if (a.status === 'uploading') {
    return `<div class="atch-chip atch-file atch-uploading" title="${esc(name)} — uploading"><span class="atch-spin">${fortress(13)}</span><span class="atch-name">${esc(name)}</span>${rm}</div>`;
  }
  if (a.status === 'failed') {
    return `<div class="atch-chip atch-file atch-failed" title="${esc(name)} — upload failed"><span class="atch-ext">✕</span><span class="atch-name">${esc(name)}</span>${rm}</div>`;
  }
  if (_IMG_EXTS.has(ext)) {
    return `<div class="atch-chip atch-img" title="${esc(name)}"><img src="/api/upload/${esc(a.id)}" alt="">${rm}</div>`;
  }
  return `<div class="atch-chip atch-file"><span class="atch-ext">${esc(ext.slice(0,4) || 'file')}</span><span class="atch-name" title="${esc(name)}">${esc(name)}</span>${rm}</div>`;
}

export const QUICK_CHIPS = [
  { label: 'What can you do?', prompt: 'What can you do?' },
  { label: 'Summarize my recent sessions', prompt: 'Summarize my recent sessions' },
  { label: 'Help me configure a channel', prompt: 'Help me configure a channel' },
  { label: 'Check system health', prompt: 'Check system health' },
];

function chatWelcome() {
  const chips = QUICK_CHIPS.map((c) =>
    `<button class="qchip occhip" data-act="fillComposer" data-arg="${esc(c.prompt)}">${esc(c.label)}</button>`
  ).join('');
  return `<div class="chat-welcome">
    <div class="cw-av"><img src="${AVATAR}" alt="__AGENT_NAME__" decoding="sync" loading="eager"></div>
    <div class="cw-name">__AGENT_NAME__</div>
    <div class="cw-hint">Type a message below &nbsp;·&nbsp; <kbd>/</kbd> for commands</div>
    <div class="cw-chips">${chips}</div>
  </div>`;
}

export function chatSurface(s) {
  const d = s.draft || '';
  const typedSlash = d.startsWith('/');
  const open = typedSlash || s.forceSlash;
  const filtered = filterSlashCommands(d);
  // slashDismissed: set by Escape (app.js) so the dropdown can be dismissed
  // without erasing what's typed — cleared the moment the draft changes again.
  const slashOpen = open && filtered.length > 0 && !s.slashDismissed;
  // Keyboard highlight (ArrowUp/Down in app.js) — falls back to the first row
  // whenever the current selection scrolled out of the filtered list.
  const slashSel = filtered.find((c) => c.name === s.slashSel) || filtered[0];
  const agent = s.chatMode === 'agent';
  const chat = s.live?.chat || {};
  // Ghost suggestion renders only for the session it was generated in — an
  // archive/delete/switch that leaves a stale stamp shows nothing rather than
  // ghosting another thread's prompt into this composer.
  // Two flavors (mirrors mobile-surfaces.js):
  //   midturn  = Gary talking to Frank while a turn runs ("while you wait…")
  //              → inline italic ✦ at the tail of the last assistant message
  //   followup = a suggested next prompt Frank could send after a clean turn
  //              → Tab-hint overlay inside the composer (unchanged)
  const _activeSug = chat.suggest && chat.suggest.sessionId === chat.activeId ? chat.suggest : null;
  const _asstSug = _activeSug && _activeSug.mode === 'midturn' ? _activeSug : null;
  const _composerSug = _activeSug && _activeSug.mode !== 'midturn' ? _activeSug : null;
  const ghost = suggestGhost(_composerSug, d);
  const _asstGhostHtml = suggestGhost(_asstSug, d, { assist: true });
  // No mock fallbacks — before live data lands the header shows neutral
  // placeholders, never invented titles/models/usage numbers.
  const title = chat.title ?? 'New chat';
  const projects = s.live?.projects || [];
  const projLabel = projectName(projects, chat.folder);
  const parentLabel = parentTitle(chat.sessions, chat.parentId);
  const subtitle = chat.subtitle ?? '';
  const model = chat.model ?? '';
  const modelLogo = providerLogo(chat.endpointId, model);
  const pct = chat.usagePct != null ? chat.usagePct : null;
  const liveMsgs = chat.thread || [];
  const prefix = s.branchPrefix || [];
  const msgs = prefix.length
    ? [
        ...prefix.map((m, i) => ({ ...m, _carried: true, _carriedFirst: i === 0 })),
        ...liveMsgs,
      ]
    : liveMsgs;
  // Find the last assistant message so we can render the midturn ghost inline
  // at its tail (was previously the composer overlay).
  let _lastAsstId = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') { _lastAsstId = msgs[i].id; break; }
  }
  const _ghostCtx = { html: _asstGhostHtml, msgId: _lastAsstId };
  const thread = map(msgs, (msg) => chatMsg(msg, s, _ghostCtx));
  const isEmpty = msgs.length === 0;

  return `
  ${when(chat.switcherOpen, renderSwitcher(s))}
  <div class="chat-head">
    <div style="min-width:0;flex:1">
      <div class="ttl">${projLabel ? `<span class="ttl-proj">${esc(projLabel)} ›</span> ` : ''}${esc(title)}</div>
      <div class="sub">${esc(subtitle)}${parentLabel ? ` · <button type="button" class="sub-parent" data-act="selectSession" data-arg="${esc(chat.parentId)}">↳ from ${esc(parentLabel)}</button>` : ''}</div>
    </div>
    <div style="position:relative">
      <button class="icon-btn ocbtn" data-act="toggleChatMenu" title="Conversation actions" style="background:none;border:none;color:var(--faint);cursor:pointer;font-size:18px;line-height:1;padding:4px 8px">⋯</button>
      ${when(s.chatMenuOpen, `
      <div class="chat-more-menu" style="position:absolute;right:0;top:30px;z-index:40;background:var(--panel,#1e2025);border:1px solid var(--border);border-radius:10px;padding:5px;min-width:170px;box-shadow:0 10px 34px rgba(0,0,0,.45)">
        <div class="cm-item" data-act="renameSession" style="padding:8px 10px;border-radius:7px;cursor:pointer">Rename</div>
        <div class="cm-item" data-act="copyTranscript" style="padding:8px 10px;border-radius:7px;cursor:pointer">Copy transcript</div>
        <div class="cm-item" data-act="exportChat" style="padding:8px 10px;border-radius:7px;cursor:pointer">Export as Markdown</div>
        <div class="cm-item" data-act="exportChatPDF" style="padding:8px 10px;border-radius:7px;cursor:pointer">Export as PDF</div>
      </div>`)}
    </div>
  </div>
  <div class="chat-thread">${isEmpty ? chatWelcome() : thread}</div>
  <div class="composer-wrap">
    ${renderChatStrip(chat.chatStrip, { renderMarkdown })}
    <button class="scroll-btm ocbtn" data-act="scrollChatBottom" title="Jump to latest" style="position:absolute;right:16px;top:-44px;z-index:25;width:34px;height:34px;border-radius:50%;background:var(--panel,#1e2025);border:1px solid var(--border);color:var(--fg);cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.45)">↓</button>
    ${when(slashOpen, `
    <div class="slash-menu" role="listbox" aria-label="Slash commands">
      <div class="hd">COMMANDS</div>
      ${map(filtered, (c) => `<div class="slash-cmd${slashSel && c.name === slashSel.name ? ' sel' : ''}" role="option" aria-selected="${slashSel && c.name === slashSel.name}" data-act="pickSlash" data-arg="${esc(c.name)}"><span class="glyph" style="color:${c.color}">${c.glyph}</span><span class="name">${esc(c.name)}</span><span class="desc">${esc(c.desc)}</span></div>`)}
    </div>`)}
    ${when(s.modelMenuOpen, modelPopover(s))}
    <div class="composer${slashOpen ? ' slash' : ''}">
      ${when(s.live?.chat?.queued, `<div class="queued-msg" data-act="queueRecall" title="Click to edit"><span class="q-ico">⏳</span><span class="q-txt">Queued — sends when the reply finishes${s.live?.chat?.queued?.text ? ` · ${esc(s.live.chat.queued.text.slice(0, 90))}` : ' · (image)'}</span><button class="q-x ocbtn" data-act="queueCancel" title="Cancel">✕</button></div>`)}
      ${ghost}
      <textarea data-model="draft" data-focus="draft" rows="1" placeholder="Message __AGENT_NAME__…   ( type / for commands )">
${esc(d)}</textarea>
      ${when(s.pendingAttach && s.pendingAttach.length, `
      <div class="attach-pending">
        ${map(s.pendingAttach || [], attachChip)}
      </div>`)}
      <div class="composer-row">
        <button class="icon-btn ocbtn" data-act="toggleSlash" title="More tools">${I.plus()}</button>
        <label class="icon-btn ocbtn" title="Attach files" style="cursor:pointer;display:inline-flex;align-items:center"><input type="file" data-upload multiple style="display:none"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></label>
        ${pct != null ? `<div class="ctx-meter" title="${esc(sessionTotalsLine(chat.sessionUsage?.totals, !!chat.sessionUsage?.costed, { provider: chat.sessionUsage?.provider }) || 'Context used')}"><div class="track"><div class="fill" style="width:${pct}%"></div></div><span class="pct">${pct}%</span></div>` : ''}
        <div class="oc-spacer"></div>
        <button class="icon-btn ocbtn" data-act="toggleIncognito" title="${s.incognito ? 'Incognito ON — this chat is not saved' : 'Incognito — don’t save this chat'}" style="${s.incognito ? 'color:var(--violet)' : ''}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7"/><path d="M2 12s3 7 10 7 10-7 10-7"/><circle cx="12" cy="12" r="2.5"/>${s.incognito ? '<line x1="3" y1="3" x2="21" y2="21"/>' : ''}</svg></button>
        <button class="model-btn ocbtn" data-act="toggleModelMenu" title="Switch model"><span class="model-provider-logo">${modelLogo}</span><span class="model-btn-name">${esc(currentModelLabel(s, model) || '…')}</span>${I.chevDownSm()}</button>
        <div class="mode-toggle">
          <button class="${agent ? 'active-agent' : ''}" data-act="setMode" data-arg="agent">Agent</button>
          <button class="${!agent ? 'active-chat' : ''}" data-act="setMode" data-arg="chat">Chat</button>
        </div>
        ${(() => { const h = steerComposerHints(s); return `
        ${h.showQueueChip ? `<button class="btn-queue ocbtn" data-act="sendQueued" title="Queue this message to send when the reply finishes (Alt+Enter)">Queue instead</button>` : ''}
        <button class="btn-send ocbtn${h.steerLabel ? ' steer' : ''}" data-act="send" title="${h.steerLabel ? 'Steer the running turn (Enter)' : 'Send'}">${I.send()}${h.steerLabel ? '<span class="send-lbl">Steer</span>' : ''}</button>`; })()}
      </div>
    </div>
  </div>`;
}

// ===========================================================================
// EMAIL
// ===========================================================================
function emailSurface(s) {
  const emails = s.live?.email?.emails || [];
  const emailUnread = emails.filter((e) => e.unread).length;
  const sel = Math.max(0, Math.min(s.selEmail, emails.length - 1));
  const m = s.live?.email?.current ?? emails[sel] ?? {};
  const attach = m.attach || [];
  const replyTo = (m.from || '').split(' ')[0];
  return `
  <div class="split-h">
    <div class="oc-secondary email-list">
      <div class="list-top">
        <div class="list-top-head"><span class="ttl">Email</span>${emailUnread > 0 ? `<span class="pill-teal">${emailUnread} unread</span>` : ''}<div class="oc-spacer"></div>${refreshBtn('email', s)}<button class="btn btn-teal" data-act="composeNew">+ New</button></div>
        <div class="oc-search">${I.search()}<input data-model="emailQuery" data-focus="emailQuery" placeholder="Search · INBOX" value="${esc(s.emailQuery || '')}" autocomplete="off" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg);font-family:inherit"></div>
      </div>
      <div class="list-scroll">
        ${emails.map((e, i) => ({ e, i })).filter(({ e }) => { const q = (s.emailQuery || '').trim().toLowerCase(); return !q || `${e.subj || ''} ${e.from || ''} ${e.src || ''}`.toLowerCase().includes(q); }).map(({ e, i }) => {
          const a = i === sel;
          return `<div class="mail-row ocrow${a ? ' active' : ''}" data-act="selEmail" data-arg="${i}">
            <div class="top"><span class="src-tag" style="color:${e.srcColor};background:${e.srcBg}">${esc(e.src)}</span>${when(e.unread, '<span class="unread-dot"></span>')}<span class="time">${esc(e.time)}</span></div>
            <div class="subj${e.unread ? ' bold' : ''}">${esc(e.subj)}</div>
            <div class="from">${esc(e.from)}</div>
          </div>`;
        }).join('')}
        ${!s.loadError?.email ? capNotice(emails.length, EMAIL_CAP) : ''}
      </div>
    </div>
    ${s.loadError?.email
      ? loadErrorBlock('Email', s)
      : s.live?.email == null
        ? `<div class="reader reader-empty"><div>Loading email…</div></div>`
        : (s.live?.email?.current || emails.length) ? `<div class="reader">
      <div class="reader-head">
        <h1>${esc(m.subj)}</h1>
        <div class="reader-from">
          <div class="reader-av" style="background:${m.avBg};color:${m.avFg}">${esc(m.initials)}</div>
          <div style="min-width:0">
            <div class="nm"><b>${esc(m.from)}</b> <span class="addr">${esc(m.fromMail)}</span></div>
            <div class="to">to ${esc(m.to)} · <span style="color:var(--faint)">${esc(m.time)}</span></div>
          </div>
        </div>
        <div class="reader-toolbar">
          <button class="btn" data-act="composeReply" data-arg="reply">${I.reply()}Reply</button>
          <button class="btn btn-ghost" data-act="composeReply" data-arg="replyall">Reply all</button>
          <button class="btn btn-ghost" data-act="composeReply" data-arg="forward">Forward</button>
          <div class="tb-divider"></div>
          <button class="btn btn-teal" data-act="composeAiDraft">✦ AI reply</button>
          <button class="btn btn-violet" data-act="summarizeEmail">✦ Summarize</button>
        </div>
        ${when(s.emailSummary, `<div class="email-summary" style="margin:8px 0 0;padding:10px 12px;background:rgba(123,182,255,.10);border:1px solid var(--border);border-radius:8px;font-size:13px;line-height:1.5"><b style="color:var(--violet)">✦ Summary</b> <span data-act="clearEmailSummary" style="float:right;cursor:pointer;color:var(--faint)">✕</span><div style="margin-top:4px;white-space:pre-wrap">${esc(s.emailSummary)}</div></div>`)}
      </div>
      <div class="reader-body">
        <div class="col">
          ${map(m.body || [], (p) => `<p>${esc(p)}</p>`)}
          ${when(attach.length > 0, `<div class="attach-row">${map(attach, (att) => `<div class="attach" title="attachment download not yet available" style="cursor:default"><span class="ico">${I.file(15, 'currentColor')}</span><div><div class="nm">${esc(att.name)}</div><div class="sz">${esc(att.size)}</div></div></div>`)}</div>`)}
        </div>
      </div>
      <div class="reply-bar">
        <div class="box" data-act="composeReply" data-arg="reply" style="cursor:text">
          <span class="ph">Reply to ${esc(replyTo)}…</span>
          <button class="btn-sm" title="AI draft" data-act="composeAiDraft">✦ Draft</button>
          <button class="btn-send-sm ocbtn" title="Reply" data-act="composeReply" data-arg="reply">${I.send(15)}</button>
        </div>
      </div>
    </div>` : `<div class="reader reader-empty"><div>No email to show yet — new mail lands here.</div></div>`}
  </div>
  ${when(s.composeOpen, composeOverlay(s))}`;
}

// Email compose/reply overlay — bound inputs (composeTo/Subject/Body), Send via
// /api/email/send. Rendered when state.composeOpen.
function composeOverlay(s) {
  const busy = !!s.emailBusy;
  return `
  <div class="oc-compose-scrim" data-act="closeCompose" aria-hidden="true" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100"></div>
  <div class="oc-compose" role="dialog" aria-modal="true" aria-label="${s.composeInReplyTo ? 'Reply' : 'New message'}" style="position:fixed;z-index:101;left:50%;top:50%;transform:translate(-50%,-50%);width:min(640px,92vw);max-height:86vh;display:flex;flex-direction:column;background:var(--panel,#1e2025);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden">
    <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border)">
      <b style="flex:1">New message</b>
      <button class="btn btn-ghost" data-act="composeAiDraft"${busy ? ' disabled' : ''}>✦ AI draft</button>
      <button type="button" class="icon-btn ocbtn" data-act="closeCompose" aria-label="Close" style="background:none;border:none;cursor:pointer;color:var(--faint);padding:0 4px;font-size:15px;line-height:1">✕</button>
    </div>
    <div style="padding:10px 14px;display:flex;flex-direction:column;gap:8px;overflow:auto">
      <input class="set-input" data-model="composeTo" data-focus="composeTo" placeholder="To (email)" value="${esc(s.composeTo || '')}" autocomplete="off" style="background:transparent;border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--fg);font-family:var(--sans)">
      <input class="set-input" data-model="composeSubject" data-focus="composeSubject" placeholder="Subject" value="${esc(s.composeSubject || '')}" autocomplete="off" style="background:transparent;border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--fg);font-family:var(--sans)">
      <textarea data-model="composeBody" data-focus="composeBody" rows="10" placeholder="Write your message…" style="background:transparent;border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--fg);font-family:var(--sans);resize:vertical">${esc(s.composeBody || '')}</textarea>
    </div>
    <div style="display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border)">
      <button class="btn btn-teal" data-act="sendEmail"${busy ? ' disabled' : ''}>${busy ? 'Sending…' : 'Send'}</button>
      <button class="btn btn-ghost" data-act="closeCompose">Cancel</button>
    </div>
  </div>`;
}

// ===========================================================================
// INBOX READER OVERLAY (desktop)
// ===========================================================================
function inboxReaderBody(r) {
  if (r.loading) return `<div class="ird-loading">Loading…</div>`;
  if (r.error) return `<div class="ird-error" style="color:var(--red)">${esc(r.error)}</div>`;
  const d = r.data || {};
  if (r.kind === 'slack') {
    const msgs = Array.isArray(d.messages) ? d.messages : [];
    if (!msgs.length) return `<div class="ird-empty">No messages found.</div>`;
    return `<div class="ird-slack-thread">${msgs.map((m) =>
      `<div class="ird-slack-msg"><span class="ird-slack-user">${esc(String(m.user || m.username || ''))}</span><span class="ird-slack-text">${esc(String(m.text || ''))}</span></div>`
    ).join('')}</div>`;
  }
  if (r.kind === 'asana') {
    const notes = esc(String(d.notes || '')).replace(/\n/g, '<br>');
    const assignee = d.assignee && (d.assignee.name || d.assignee) ? esc(String(d.assignee.name || d.assignee)) : null;
    const due = d.due_on ? esc(String(d.due_on)) : null;
    const stories = Array.isArray(d.stories) ? d.stories : (Array.isArray(d.comments) ? d.comments : []);
    const commentHtml = stories.length
      ? `<div class="ird-asana-comments">${stories.filter((c) => c.type === 'comment' || c.text || c.body).map((c) =>
          `<div class="ird-asana-comment"><span class="ird-slack-user">${esc(String((c.created_by && c.created_by.name) || c.author || ''))}</span><span class="ird-slack-text">${esc(String(c.text || c.body || ''))}</span></div>`
        ).join('')}</div>`
      : '';
    return `<div class="ird-asana">
      ${when(assignee, `<div class="ird-meta">Assignee: <b>${assignee}</b></div>`)}
      ${when(due, `<div class="ird-meta">Due: <b>${due}</b></div>`)}
      ${notes ? `<div class="ird-notes" style="white-space:pre-wrap;margin-top:8px">${notes}</div>` : ''}
      ${commentHtml}
    </div>`;
  }
  if (r.kind === 'gmail') {
    // Safe approach: use email.js stripHtml logic is not importable here at render time,
    // so we render paragraphs from the plain body field (already stripped by the API)
    // or fall back to escaped raw body. This is SAFE — no HTML injection.
    const rawBody = d.body || d.body_html || '';
    // Detect HTML; strip tags server-side text is preferred but if HTML slips through, escape it.
    const isHtml = /<[a-z!][\s\S]*>/i.test(String(rawBody));
    if (isHtml) {
      // Strip HTML client-side by replacing tags with spaces, then escape.
      const stripped = String(rawBody)
        .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(p|div|tr|li|h[1-6]|blockquote)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
        .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const paras = stripped.split(/\n\n+/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
      return `<div class="ird-gmail">${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`;
    }
    const paras = String(rawBody).trim().split(/\n\n+/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
    return `<div class="ird-gmail">${paras.length ? paras.map((p) => `<p>${esc(p)}</p>`).join('') : `<p>${esc(String(rawBody))}</p>`}</div>`;
  }
  return `<div class="ird-empty">No content.</div>`;
}

function inboxReaderOverlay(s) {
  const r = s.inboxReader;
  if (!r) return '';
  const items = s.live?.inbox?.items || [];
  const item = items.find((m) => m.id === r.id) || {};
  const title = item.who || r.id || 'Detail';
  return `
    <div class="inbox-reader-scrim" data-act="closeReader" aria-hidden="true" style="position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:40"></div>
    <div class="inbox-reader-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="position:absolute;right:0;top:0;bottom:0;width:min(480px,100%);background:var(--panel,#1e2025);border-left:1px solid var(--border);display:flex;flex-direction:column;z-index:41;overflow:hidden">
      <div class="ird-header" style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
        <span style="font-weight:600;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</span>
        <button type="button" class="icon-btn ocbtn" data-act="closeReader" aria-label="Close" title="Close" style="background:none;border:none;cursor:pointer;color:var(--faint);font-size:15px;line-height:1;padding:2px 4px">✕</button>
      </div>
      <div class="ird-body" style="flex:1;overflow-y:auto;padding:16px;font-size:13px;line-height:1.6">
        ${inboxReaderBody(r)}
      </div>
    </div>`;
}

// ===========================================================================
// INBOX HISTORY DRAWER
// ===========================================================================
function inboxHistoryDrawer(s) {
  const entries = Array.isArray(s.inboxHistory) ? s.inboxHistory : [];
  const now = Date.now();
  const ageStr = (ts) => {
    const diffMs = now - (ts || 0);
    const diffM = Math.round(diffMs / 60000);
    if (diffM < 2) return 'just now';
    if (diffM < 60) return `${diffM}m ago`;
    const diffH = Math.round(diffM / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return `${Math.round(diffH / 24)}d ago`;
  };
  const rowHtml = (e) => {
    const age = ageStr(e.ts);
    const note = e.note ? ` · ${esc(e.note)}` : '';
    return `<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
      <div style="min-width:0;flex:1">
        <span style="font-size:12px;color:var(--teal);text-transform:uppercase;margin-right:6px">${esc(e.action || '')}</span><span style="font-size:13px">${esc(e.title || e.id || '')}</span>
        <div style="font-size:11px;color:var(--faint);margin-top:2px">${esc(age)}${note}</div>
      </div>
      ${e.undoable ? `<button class="btn-sm ghost" data-act="undoRow" data-arg="${esc(String(e.ts))}" title="Undo this action">Undo</button>` : ''}
    </div>`;
  };
  return `
    <div style="position:absolute;right:0;top:0;bottom:0;width:min(360px,100%);background:var(--panel,#1e2025);border-left:1px solid var(--border);display:flex;flex-direction:column;z-index:41;overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
        <span style="font-weight:600;font-size:14px;flex:1">Recent Actions</span>
        <span data-act="toggleHistory" style="cursor:pointer;color:var(--faint);font-size:18px;line-height:1;padding:2px 4px" title="Close">✕</span>
      </div>
      <div style="flex:1;overflow-y:auto;padding:0 16px 16px">
        ${entries.length ? entries.map(rowHtml).join('') : '<div style="padding:16px 0;color:var(--faint);font-size:13px">No recent actions.</div>'}
      </div>
    </div>`;
}

// ===========================================================================
// INBOX
// ===========================================================================
function inboxSurface(s) {
  const items = s.live?.inbox?.items || [];
  const visible = filterVisible(items, { dismissed: s.dismissed, filter: s.inboxFilter });
  const needs = visible.filter((m) => m.group === 'needs');
  const fyi = visible.filter((m) => m.group === 'fyi');

  const bodyAttr = (it) => detailEndpoint(it) ? ` data-act="openReader" data-arg="${esc(it.id)}" style="cursor:pointer"` : '';
  // Snooze preset popover — rendered inline inside the card when open.
  // Action naming: "snooze" (from cardButtonsHtml data-act) opens the menu;
  // "snoozeFor" with arg "<id>:<preset>" commits and fires the real POST.
  const snoozeMenu = (it) => when(s.inboxSnoozeFor === it.id, `
    <div class="snooze-menu" style="display:flex;align-items:center;gap:6px;padding:6px 0 2px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--faint);margin-right:2px">Snooze:</span>
      ${['later', 'tomorrow', 'nextweek'].map((p) =>
        `<button class="btn-sm ghost" data-act="snoozeFor" data-arg="${esc(it.id + ':' + p)}">${p === 'later' ? '4 h' : p === 'tomorrow' ? 'Tomorrow' : 'Next week'}</button>`
      ).join('')}
      <button class="btn-sm ghost" data-act="closeSnooze" style="margin-left:auto">Cancel</button>
    </div>`);
  // Ingest source pointers are debugging refs, not content (task 5.1a):
  // render just the source file name as a subtle one-line meta ref — the full
  // pointer lives in the tooltip, and nothing mid-word-wraps as fake prose.
  const bodyInner = (it) => bodyIsPath(it.body)
    ? `<span class="body-src" title="${esc(it.body)}">${esc(pointerRefLabel(it.body))}</span>`
    : esc(stripMd(it.body));
  const needsCard = (it) => `
    <div class="inbox-card">
      <div class="top"><span class="src-tag" style="color:${it.srcColor};background:${it.srcBg}">${esc(it.src)}</span><span class="who">${esc(stripMd(it.who))}</span><span class="ago">· ${esc(it.time)}</span><span class="inbox-x" data-act="dismiss" data-arg="${esc(it.id)}">${I.x()}</span></div>
      <div class="body"${bodyAttr(it)}>${bodyInner(it)}</div>
      ${when(it.source === 'obsidian' && it.rec && it.rec.due, `<div class="ai-pill">✦ task · due ${esc((it.rec || {}).due || '')}</div>`)}
      ${cardButtonsHtml(it, esc, { moreOpen: s.inboxMoreFor === it.id })}
      ${snoozeMenu(it)}
    </div>`;
  const fyiCard = (it) => `
    <div class="inbox-card fyi">
      <div class="top"><span class="src-tag" style="color:${it.srcColor};background:${it.srcBg}">${esc(it.src)}</span><span class="who">${esc(stripMd(it.who))}</span><span class="ago">· ${esc(it.time)}</span><span class="inbox-x" data-act="dismiss" data-arg="${esc(it.id)}">${I.x()}</span></div>
      <div class="body"${bodyAttr(it)}>${bodyInner(it)}</div>
      <button class="ai-pill" data-act="applyRec" data-arg="${esc(it.id)}">✦ ${esc(it.suggest)}</button>
      ${cardButtonsHtml(it, esc, { moreOpen: s.inboxMoreFor === it.id })}
      ${snoozeMenu(it)}
    </div>`;
  // Bespoke card for the `entities` source: no cardActions/cardButtonsHtml (the
  // backend actions[] list is confirm/reclassify/not_entity, not the universal
  // clear-verb set) — confirm is the primary, the other four types are ghost
  // reclassify chips, and the corner ✕ means "not an entity" (not dismiss).
  const entityCard = (it) => {
    const v = entityView(it);
    return `
    <div class="inbox-card entity-card">
      <div class="top"><span class="src-tag" style="color:${it.srcColor};background:${it.srcBg}">ENTITY</span><span class="who">${esc(stripMd(it.who))}</span><span class="ago">· guessed: ${esc(v.guess)}</span><button class="inbox-x" data-act="notEntity" data-arg="${esc(it.id)}" title="Not an entity">${I.x()}</button></div>
      <div class="body">${bodyInner(it)}</div>
      <div class="card-actions">
        <button class="btn-sm" data-act="confirm" data-arg="${esc(it.id)}">${esc(v.confirmLabel)}</button>
        ${v.chips.map((c) => `<button class="btn-sm ghost" data-act="reclassify" data-arg="${esc(it.id + ':' + c.type)}">${esc(c.label)}</button>`).join('')}
        <button class="ic-btn" data-act="open" data-arg="${esc(it.id)}" title="Open source">↗</button>
        <button class="ic-btn" data-act="snooze" data-arg="${esc(it.id)}" title="Snooze">${I.clock(13)}</button>
      </div>
      ${snoozeMenu(it)}
    </div>`;
  };
  const inboxCard = (it) => it.source === 'entities' ? entityCard(it) : (it.group === 'fyi' ? fyiCard(it) : needsCard(it));

  return `
  <div class="inbox-col" style="position:relative">
    <div class="inbox-head">
      <div class="row1">
        <span class="ttl">Inbox</span><span class="cnt">${visible.length} to triage</span>
        <div class="oc-spacer"></div>
        <button class="triage-btn" data-act="triageAll">✦ Triage with __AGENT_NAME__</button>
        <button class="btn-hist ocbtn${s.inboxHistoryOpen ? ' on' : ''}" data-act="toggleHistory" title="Recent actions">${I.clock(13)}<span>History</span></button>
        ${refreshBtn('inbox', s)}
      </div>
      ${chipRowHtml(
        sourceCounts(items, { dismissed: s.dismissed }, s.live?.inbox?.sources),
        { filter: s.inboxFilter, errors: s.live?.inbox?.errors || {} },
        esc)}
    </div>
    ${(() => {
      // Apply-all summary bar (Option A): appears after a "Triage with __AGENT_NAME__"
      // pass, until Frank taps Apply all or Review. Nothing acts without a tap.
      if (!s.inboxTriaged || s.inboxTriageReviewed) return '';
      const sum = triageSummary(items, s.dismissed || []);
      if (!sum.total) return '';
      return `<div class="triage-summary">
        <span class="ts-label">✦ __AGENT_NAME__ suggests: ${esc(triageSummaryText(sum.counts))}</span>
        <div class="oc-spacer"></div>
        <button class="btn-sm" data-act="applyAll">Apply all</button>
        <button class="btn-sm ghost" data-act="reviewTriage">Review</button>
      </div>`;
    })()}
    <div class="inbox-scroll">
      ${when(needs.length > 0, `<div class="grp-label"><span class="lbl needs">NEEDS YOU</span><span class="n">${needs.length}</span><div class="sect-divider"></div></div>${map(needs, inboxCard)}`)}
      ${when(fyi.length > 0, `<div class="grp-label fyi"><span class="lbl fyilbl">AI-SUGGESTED · FYI</span><span class="n">${fyi.length}</span><div class="sect-divider"></div></div>${map(fyi, inboxCard)}`)}
      ${s.loadError?.inbox
        ? loadErrorBlock('Inbox', s)
        : s.live?.inbox == null
          ? `<div class="inbox-zero loading"><div class="d">Loading inbox…</div></div>`
          : when(visible.length === 0, `<div class="inbox-zero"><div class="ico">${I.check()}</div><div class="t">Inbox zero</div><div class="d">__AGENT_NAME__ cleared the feed. Nothing left to triage.</div></div>`)}
      ${!s.loadError?.inbox ? capNotice(items.length, INBOX_CAP) : ''}
    </div>
    ${when(!!s.inboxEditFor, `
      <div class="inbox-edit-sheet">
        <div class="ies-row"><b>Add to Asana</b><span class="oc-spacer"></span><span data-act="closeEdit" style="cursor:pointer">✕</span></div>
        <input class="set-input" data-model="inboxEditTask" value="${esc((s.inboxEditFor && s.inboxEditFor.task) || '')}" />
        <div class="ies-due">Due: <b>${esc((s.inboxEditFor && s.inboxEditFor.due) || 'none')}</b></div>
        <div class="ies-chips">
          ${['today', 'tomorrow', 'fri', 'nextweek', 'none'].map((c) => `<span class="due-chip" data-act="pickDue" data-arg="${c}">${c}</span>`).join('')}
        </div>
        <div class="ies-actions"><button class="btn-sm" data-act="confirmAddAsana">Add task</button><button class="btn-sm ghost" data-act="closeEdit">Cancel</button></div>
      </div>`)}
    ${when(!!s.inboxReader, inboxReaderOverlay(s))}
    ${when(!!s.inboxHistoryOpen, inboxHistoryDrawer(s))}
  </div>`;
}

// Undo/notice toast. Rendered by the desktop SHELL (app.js renderDesktop), not
// by a surface — the error boundary reports through state.inboxToast, and a
// surface-scoped render made errors invisible everywhere but Inbox. Mobile
// renders its own copy at shell level (mobile-surfaces.js).
export function inboxToastHtml(s) {
  if (!s.inboxToast) return '';
  return `
      <div class="inbox-toast" style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:var(--panel,#1e2025);border:1px solid var(--border);border-radius:8px;padding:10px 14px;box-shadow:0 4px 20px rgba(0,0,0,.4);z-index:80;white-space:nowrap">
        <span>${esc(s.inboxToast.msg)}</span>
        ${(s.inboxToast.undoTs || s.inboxToast.undoLocal || (s.inboxToast.undoBatch && s.inboxToast.undoBatch.length)) ? `<button class="btn-sm" data-act="undo">Undo</button>` : ''}
        <span data-act="dismissToast" style="cursor:pointer;color:var(--faint);margin-left:4px">✕</span>
      </div>`;
}

// ===========================================================================
// CALENDAR
// ===========================================================================
function calendarSurface(s) {
  const q = (s.quick || '').trim();
  const has = q.length > 0;
  const hlUid = s.calHighlightUid;
  // Temporary highlight for the event a quick-add just created (keyed by its
  // real uid — live/calendar.js clears it a few seconds after the create
  // resolves). No CSS file changes needed: reuses the `pulse` keyframe that
  // already ships in redesign.css for other momentary-attention cases.
  const hlStyle = 'animation:pulse 1.4s ease-in-out 2;box-shadow:0 0 0 2px var(--teal) inset;border-radius:4px';
  const cell = (c) => {
    const cls = ['cal-cell'];
    if (c.last) cls.push('last');
    if (c.today) cls.push('today');
    const dateHtml = c.today
      ? `<div><span class="cal-today-num">${c.date}</span></div>`
      : `<div class="cal-date${c.dim ? ' dim' : ''}">${c.date}</div>`;
    const bars = (c.bars || []).map((b) => {
      const t = CAL_BAR_TONE[b.tone];
      const hl = !!(b.uid && b.uid === hlUid);
      const style = `background:${t.bg};color:${t.color}${hl ? `;${hlStyle}` : ''}`;
      return `<div class="bar${hl ? ' hl' : ''}" style="${style}">${b.label ? esc(b.label) : '&nbsp;'}</div>`;
    }).join('');
    const events = (c.events || []).map((e) => {
      const hl = !!(e.uid && e.uid === hlUid);
      const styles = [];
      if (e.faded) styles.push('opacity:.5');
      if (hl) styles.push(hlStyle);
      const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
      return `<div class="ev${hl ? ' hl' : ''}"${styleAttr}><span class="evdot" style="background:${e.dot}"></span>${esc(e.label)}</div>`;
    }).join('');
    const more = c.more ? `<div class="cal-more">${esc(c.more)}</div>` : '';
    return `<div class="${cls.join(' ')}">${dateHtml}${bars}${events}${more}</div>`;
  };
  const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const cells = s.live?.calendar?.cells || [];
  const month = s.live?.calendar?.month || '';
  return `
  <div class="cal-col">
    <div class="cal-top">
      <div class="cal-toolbar">
        <button class="btn btn-ghost" data-act="calToday">Today</button>
        <button class="cal-nav" data-act="calPrev" title="Previous month" aria-label="Previous month">‹</button>
        <span class="cal-month">${esc(month)}</span>
        <button class="cal-nav" data-act="calNext" title="Next month" aria-label="Next month">›</button>
        <div class="oc-spacer"></div>
        <button class="btn btn-teal" data-act="newEvent">+ New</button>
      </div>
      <div class="cal-quick${has ? ' has' : ''}">
        <span class="star">✦</span>
        <input data-model="quick" data-focus="quick" placeholder="Quick add — try “lunch with Sam tue 1pm” or “feed Krypto 1pm tmrw”" value="${esc(s.quick || '')}"/>
        ${when(has, '<button class="cal-add" data-act="clearQuick">↵ Add</button>')}
      </div>
    </div>
    <div class="cal-weekdays">${map(weekdays, (d) => `<div>${d}</div>`)}</div>
    ${cells.length
      ? `<div class="cal-grid">${map(cells, cell)}</div>`
      // Fix round 1, finding 3: this used to show the same "hasn't loaded"
      // copy whether the calendar had simply never loaded yet OR a real nav
      // had just failed — silently indistinguishable, and its Retry button
      // never reflected state.loadError.calendar at all. A real load
      // failure (nothing to show — see live/index.js's populated-surface
      // policy, which means loadError.calendar is only ever set when there
      // truly is no data) now gets the same shared error partial every
      // other surface uses; the plain "hasn't loaded yet" copy is left for
      // the genuinely-not-loaded-yet case (first render, before any load
      // has resolved either way).
      : s.loadError?.calendar
        ? loadErrorBlock('Calendar', s)
        : `<div class="cal-empty" style="flex-direction:column;gap:10px">Calendar hasn’t loaded.<button class="btn-sm" data-act="retrySurface" data-arg="calendar">Retry</button></div>`}
  </div>`;
}

// ===========================================================================
// RESEARCH
// ===========================================================================
function researchSurface(s) {
  const has = (s.researchQuery || '').trim().length > 0;
  const running = s.research === 'running';
  const done = s.research === 'done';
  const errored = s.research === 'error';

  const ctlPills = RESEARCH_CONTROLS.map((c) => {
    const val = s.resCfg[c.key];
    const isOpen = s.resOpenCtl === c.key;
    const isDefault = val === c.opts[0];
    const on = isOpen || !isDefault;
    const popover = isOpen ? `
      <div class="res-pop">
        ${c.opts.map((o) => `<div class="res-opt${o === val ? ' sel' : ''}" data-act="pickResOpt" data-arg="${c.key}:${esc(o)}"><span class="nm">${esc(o)}</span>${o === val ? '<span class="ck">✓</span>' : ''}</div>`).join('')}
      </div>` : '';
    return `<div class="res-ctl-wrap">
      <button class="res-ctl${on ? ' on' : ''}" data-act="toggleResCtl" data-arg="${c.key}"><span class="ck">${esc(c.label)}</span><b>${esc(val)}</b>${I.chevDown(11)}</button>
      ${popover}
    </div>`;
  }).join('');

  // No scope chips: they dispatched no action and the backend start route
  // reads nothing scope-shaped that changes the run (task 5.3).
  return `
  <div class="oc-head">${I.research(17, 'var(--teal)')}<span class="title">Deep Research</span><span class="desc">multi-step web research, LLM in the loop</span></div>
  <div class="res-wrap">
    <div class="res-inner">
      <div class="res-composer${has ? ' has' : ''}">
        <textarea data-model="researchQuery" data-focus="researchQuery" rows="2" placeholder="What should __AGENT_NAME__ investigate? e.g. “Compare the top 3 podcast hosting platforms on price, analytics, and Wistia integration.”">${esc(s.researchQuery || '')}</textarea>
        <div class="res-controls">
          <span class="lbl">Defaults — click any to override:</span>
          ${ctlPills}
          <div class="oc-spacer"></div>
          <button class="res-start" data-act="startResearch">${I.play()}Start</button>
        </div>
      </div>

      ${when(running, `
      <div class="res-card running">
        <div class="row1"><span class="res-spin">${fortress(14)}</span><span class="running-ttl">${esc(s.researchProgress?.label || 'Researching…')}</span><div class="oc-spacer"></div><button class="btn btn-ghost" style="height:28px" data-act="resetResearch">Stop</button></div>
      </div>`)}

      ${when(done, `
      <div class="res-card done">
        <div class="row1"><span class="res-done-ico">✓</span><span class="t">Report ready</span><div class="oc-spacer"></div><button class="btn btn-ghost" style="height:30px" data-act="resetResearch">New research</button></div>
        <p class="res-summary">${s.live?.research?.summary || ''}</p>
        <div class="card-actions"><button class="btn-sm" data-act="resReport" data-arg="${esc(s.live?.research?.lastRid || '')}">↗ Visual Report</button><button class="btn-sm ghost" data-act="resDiscuss" data-arg="${esc(s.live?.research?.lastRid || '')}">Discuss in chat</button><button class="btn-sm ghost" data-act="go" data-arg="library" title="Finished runs are already saved — this opens the Library">In Library →</button></div>
      </div>`)}

      ${when(errored, `
      <div class="res-card error" style="border-color:var(--red);background:rgba(240,114,106,.08)">
        <div class="row1"><span class="res-done-ico" style="color:var(--red)">⚠</span><span class="t">Research failed</span><div class="oc-spacer"></div><button class="btn btn-ghost" style="height:30px" data-act="resetResearch">Dismiss</button></div>
        <p class="res-summary">${esc(s.researchError || 'Something went wrong.')}</p>
        <div class="card-actions"><button class="btn-sm" data-act="startResearch">Retry</button></div>
      </div>`)}

      ${s.loadError?.research ? loadErrorBlock('Research', s) : `
      <div class="grp-label" style="margin:18px 0 12px"><span class="sect-label">PAST RESEARCH</span><span class="n" style="font-size:11px;color:var(--faint)">${(s.live?.research?.past || []).length}</span><div class="sect-divider"></div><span style="font-size:11.5px;color:var(--teal);cursor:pointer" data-act="go" data-arg="library">Library, Research →</span></div>
      ${map(s.live?.research?.past || [], (r) => `<div class="past-row"><div class="top"><span class="q">${esc(r.q)}</span><span class="m" title="run duration · sources fetched">${esc(r.m)}</span></div><div class="chips"><span class="chip-teal"${r.rid ? ` data-act="resDiscuss" data-arg="${esc(r.rid)}"` : ''}>Discuss</span><span class="chip-ghost"${r.rid ? ` data-act="resReport" data-arg="${esc(r.rid)}"` : ''}>↗ Visual Report</span></div></div>`)}
      ${capNotice((s.live?.research?.past || []).length, RESEARCH_CAP)}`}
    </div>
  </div>`;
}

// ===========================================================================
// LIBRARY
// ===========================================================================
function librarySurface(s) {
  const lf = s.libFilter;
  const all = s.live?.library?.items || [];
  const lq = (s.libQuery || '').trim().toLowerCase();
  const items = all.filter((a) => (lf === 'all' || a.cat === lf) && (!lq || String(a.title || '').toLowerCase().includes(lq)));
  return `
  <div class="oc-head">${I.library(17, 'var(--teal)')}<span class="title">Library</span><span class="desc">artifacts __AGENT_NAME__ has produced</span><div class="oc-spacer"></div>${refreshBtn('library', s)}<button class="btn btn-teal" data-act="newDoc" style="margin-right:8px">+ New doc</button><div class="oc-search" style="height:32px;border-radius:8px">${I.search(13, 'currentColor')}<input data-model="libQuery" data-focus="libQuery" placeholder="Filter library…" value="${esc(s.libQuery || '')}" autocomplete="off" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg);font-family:inherit"></div></div>
  <div class="lib-wrap">
    <div class="lib-filters">
      ${map(LIB_FILTERS, ([id, label]) => `<span class="lib-filter${lf === id ? ' active' : ''}" data-act="libFilter" data-arg="${id}">${esc(label)}</span>`)}
    </div>
    <div class="lib-grid">
      ${s.loadError?.library ? loadErrorBlock('Library', s) : map(items, (a) => {
        const k = KIND_STYLE[a.kind];
        const openable = a.id && (a.cat === 'doc' || a.cat === 'code');
        // Thumb (task 5.4): first lines of the artifact's content when the
        // list API carries any (documents `preview`, notes `content`);
        // otherwise a kind-colored icon over the kind label — not the old
        // flat all-caps text block.
        const snip = (a.snippet || '').trim();
        const kindIco = ({ REPORT: I.research, DOC: I.library, NOTE: I.notes, CODE: I.code })[a.kind] || I.file;
        const thumb = snip
          ? `<div class="lib-thumb has-snip" style="background:${k.thumbBg}"><span class="snip">${esc(snip)}</span></div>`
          : `<div class="lib-thumb" style="background:${k.thumbBg}"><span class="k-ico" style="color:${k.kindColor}">${kindIco(22)}</span><span class="kl" style="color:${k.kindColor}">${esc(a.kindLabel)}</span></div>`;
        return `<div class="lib-card"${openable ? ` data-act="openDoc" data-arg="${esc(a.id)}" style="cursor:pointer"` : ''}>
          ${thumb}
          <div class="meta">
            <div class="t">${esc(a.title)}</div>
            <div class="tags"><span class="lib-tag" style="color:${k.kindColor};background:${k.tagBg}">${esc(a.kind)}</span><span class="when">${esc(a.when)}</span></div>
          </div>
        </div>`;
      })}
    </div>
    ${!s.loadError?.library ? capNotice(all.length, LIBRARY_CAP) : ''}
  </div>`;
}

// ===========================================================================
// NOTES
// ===========================================================================
function notesSurface(s) {
  if (s.loadError?.notes) {
    return `<div class="split-h">${loadErrorBlock('Notes', s)}</div>`;
  }
  const docs0 = s.live?.notes?.docs || [];
  const sel = Math.max(0, Math.min(s.selDoc, docs0.length - 1));
  const doc = docs0[sel] || { title: '', meta: '', path: '', version: 0, blocks: [] };
  const block = (b) => {
    if (b.t === 'h') return `<h2>${esc(b.text)}</h2>`;
    if (b.t === 'quote') return `<blockquote>${esc(b.text)}</blockquote>`;
    if (b.t === 'list') return `<ul>${map(b.items, (li) => `<li>${esc(li)}</li>`)}</ul>`;
    return `<p>${esc(b.text)}</p>`;
  };
  return `
  <div class="split-h">
    <div class="oc-secondary notes-list">
      <div class="list-top">
        <div class="list-top-head"><span class="ttl">Notes</span><span style="font-size:11px;color:var(--faint)">${s.live?.notes?.docs ? `vault · ${s.live.notes.docs.length}` : ''}</span><div class="oc-spacer"></div>${refreshBtn('notes', s)}<button class="btn btn-teal" data-act="newNote">+ New</button></div>
        <div class="oc-search">${I.search()}<input data-model="notesFilter" data-focus="notesFilter" placeholder="Search notes…" value="${esc(s.notesFilter || '')}" autocomplete="off" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg);font-family:inherit"></div>
      </div>
      <div class="list-scroll">
        ${docs0.map((n, i) => ({ n, i })).filter(({ n }) => { const q = (s.notesFilter || '').trim().toLowerCase(); return !q || String(n.title || '').toLowerCase().includes(q); }).map(({ n, i }) => {
          const a = i === sel;
          return `<div class="note-row${a ? ' active' : ''}" data-act="selDoc" data-arg="${i}">
            <div class="top">${I.file(13, a ? 'var(--teal)' : 'var(--faint)')}<span class="nm">${esc(n.title)}</span></div>
            <div class="meta">v${n.version} · ${esc(n.meta.split('·')[0].trim())}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="note-editor">
      <div class="note-ehead"><span class="path">${esc(doc.path)}</span><div class="oc-spacer"></div><span class="note-saved"><span class="d"></span>saved · v${doc.version}</span></div>
      <div class="note-doc">
        <div class="col">
          <h1>${esc(doc.title)}</h1>
          <div class="meta">${esc(doc.meta)}</div>
          ${map(doc.blocks, block)}
        </div>
      </div>
    </div>
  </div>`;
}

// ===========================================================================
// SETTINGS
// ===========================================================================

// Inline scheduled-jobs panel (rendered in the Scheduled card after openScheduled
// loads state.live.cron from GET /api/cron).
function cronPanel(cron) {
  const jobs = (cron && cron.jobs) || [];
  if (cron && cron.error) return `<div style="padding:8px 2px;color:var(--faint);font-size:12px">Scheduler unavailable.</div>`;
  if (!jobs.length) return `<div style="padding:8px 2px;color:var(--faint);font-size:12px">No scheduled jobs.</div>`;
  return `<div class="cron-list" style="margin-top:10px;display:flex;flex-direction:column;gap:6px">${jobs.map((j) => `
    <div class="cron-job" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1e2025;border-radius:8px">
      <span style="width:7px;height:7px;border-radius:50%;flex:none;background:${j.enabled ? 'var(--green)' : 'var(--faint)'}"></span>
      <div style="min-width:0;flex:1"><div style="font-size:13px">${esc(j.name || j.id)}</div><div class="mono" style="font-size:11px;color:var(--faint)">${esc(j.schedule_expr || j.schedule || '')}</div></div>
      <button class="set-btn" data-act="cronRun" data-arg="${esc(j.id)}" style="height:26px">Run</button>
      <button class="set-btn" data-act="cronToggle" data-arg="${esc(j.id)}" style="height:26px">${j.enabled ? 'Disable' : 'Enable'}</button>
    </div>`).join('')}</div>`;
}

// Inline Brain panel (memories + skills) loaded by openBrain.
function brainPanel(brain) {
  const mems = (brain && brain.memory) || [];
  const skills = (brain && brain.skills) || [];
  return `
  <div style="margin-top:10px">
    <div style="font-size:11px;color:var(--faint);margin-bottom:6px">MEMORIES · ${mems.length}</div>
    <div style="display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto">
      ${mems.length ? mems.map((m) => `<div style="padding:7px 10px;background:#1e2025;border-radius:8px;font-size:13px"><div>${esc(m.text || m.content || m.name || '')}</div>${m.category ? `<div style="font-size:11px;color:var(--faint);margin-top:2px">${esc(m.category)}</div>` : ''}</div>`).join('') : '<div style="color:var(--faint);font-size:12px;padding:4px 0">No memories yet.</div>'}
    </div>
    <div style="font-size:11px;color:var(--faint);margin:12px 0 6px">SKILLS · ${skills.length}</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${skills.length ? skills.map((sk) => `<span style="padding:4px 9px;background:#2a2d33;border-radius:7px;font-size:12px">${esc((sk && (sk.name || sk.id)) || sk)}</span>`).join('') : '<div style="color:var(--faint);font-size:12px">No skills yet.</div>'}
    </div>
  </div>`;
}

function settingsSurface(s) {
  const sec = TAB[s.setSection] ? s.setSection : 'services';
  const ui = s.ui;
  const accent = s.accent;

  // section nav
  let nav = '';
  NAV_GROUPS.forEach((g) => {
    if (g === 'div') { nav += '<div class="set-nav-div"></div>'; return; }
    let ids = g;
    if (g.label) { nav += `<div class="set-nav-label">${esc(g.label)}</div>`; ids = g.ids; }
    ids.forEach((id) => {
      const on = sec === id;
      nav += `<div class="set-nav-item${on ? ' active' : ''}" data-act="setSection" data-arg="${id}"><span class="ico">${icon(TAB[id][2], { size: 15, sw: 1.8 })}</span>${esc(TAB[id][0])}</div>`;
    });
  });

  const toggle = (on, sm) => `<div class="toggle${sm ? ' sm' : ''}${on ? ' on' : ''}"><span class="knob"></span></div>`;

  const renderRow = (r) => {
    switch (r.type) {
      case 'head':
        return `<div class="set-row-head">${r.icon ? `<span style="display:flex">${icon(r.icon, { size: 12, sw: 1.8 })}</span>` : ''}${esc(r.text)}</div>`;
      case 'select':
        return `<div class="set-field"><span class="k">${esc(r.label)}</span><div class="v between mono" style="color:${r.muted ? 'var(--faint)' : 'var(--fg)'}">${esc(r.value)}<span style="color:var(--faint)">▾</span></div></div>`;
      case 'input':
        if (r.model) {
          const mval = s[r.model] != null ? s[r.model] : '';
          return `<div class="set-field"><span class="k">${esc(r.label)}</span><input class="set-input" type="${r.itype || 'text'}" data-model="${r.model}" data-focus="${r.model}" placeholder="${esc(r.ph || '')}" value="${esc(mval)}" autocomplete="off" style="flex:1;min-width:0;background:transparent;border:none;outline:none;text-align:right;color:var(--fg);font-family:var(--sans)"></div>`;
        }
        return `<div class="set-field"><span class="k">${esc(r.label)}</span><div class="v" style="color:${r.hasValue ? 'var(--fg)' : 'var(--faint)'};font-family:var(--sans)">${esc(r.value)}</div></div>`;
      case 'textarea':
        return `<div class="set-textarea">${esc(r.value)}</div>`;
      case 'chips':
        return `<div class="set-chips"><span class="k">${esc(r.label)}</span>${map(r.chips, (ch) => `<span class="set-chip">${esc(ch)}</span>`)}<span class="set-add">+ add</span></div>`;
      case 'buttons':
        // A button with no action is not wired to anything yet — render it
        // disabled instead of fake-clickable.
        return `<div class="set-buttons">${map(r.buttons, (b) => `<button class="set-btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}"${b.act ? ` data-act="${b.act}"${b.arg != null ? ` data-arg="${esc(String(b.arg))}"` : ''}` : ' disabled title="Not wired up yet"'}>${esc(b.label)}</button>`)}</div>`;
      case 'liveModels': {
        // Real endpoints/models from the gateway (state.live.modelGroups —
        // filled by loadModelOptions from GET /api/models).
        const groups = s.live?.modelGroups || [];
        if (!groups.length) return '<div class="set-text set-live-empty">Model list hasn’t loaded yet — it fills in from the gateway when chat boots.</div>';
        return groups.map((g) => `<div class="set-endpoint"><span class="ico" style="background:var(--tealtint);color:var(--teal)">${esc(String(g.ep || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?')}</span><div style="min-width:0;flex:1"><div class="nm">${esc(g.ep)}</div><div class="det">${esc(g.models.map((m) => m.name).join(', '))}</div></div><span class="st" style="color:var(--green)"><span class="d" style="background:var(--green)"></span>Active</span></div>`).join('');
      }
      case 'liveUsage': {
        const u = s.live?.usage;
        if (!u) return '<div class="set-text set-live-empty">Loading usage…</div>';
        return usagePanelHtml({ days: u.days || 7, daily: (u.data && u.data.daily) || [], totals: u.data && u.data.totals, costed: !!(u.data && u.data.costed), fresh: u.fresh !== false, error: u.error });
      }
      case 'liveChanges': {
        // The generic data-model handler (app.js) writes typed drafts straight
        // to top-level state (state.changesRootDraft / state.changesPruneDraft)
        // — not into state.live.changesSettings — and these two fields aren't
        // in app.js's PLAIN_SHEET_FIELDS skip-list, so every keystroke here
        // still triggers a full render(). Feeding the live draft back in as
        // model.draftRoot/pruneDraft keeps the rebuilt input/textarea showing
        // exactly what was just typed instead of snapping back to the last
        // saved value.
        const cs = s.live?.changesSettings || null;
        return changesSettingsHtml(cs ? { ...cs, draftRoot: s.changesRootDraft || '', pruneDraft: s.changesPruneDraft } : null);
      }
      case 'liveDefault': {
        const def = s.live?.defaultModel || '';
        const hit = (s.live?.modelList || []).find((m) => m.id === def);
        if (!hit) return '<div class="set-text set-live-empty">No default recorded yet — set one with the ★ next to any model in the model picker.</div>';
        return `<div class="set-field"><span class="k">Default</span><div class="v" style="color:var(--fg);font-family:var(--sans)">${esc(hit.name)} · via ${esc(hit.ep)}</div></div><div class="set-text">Change it with the ★ next to any model in the model picker.</div>`;
      }
      case 'provider': {
        const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const cur = s.searchProvider || r.cur;
        return `<div class="set-providers">${map(r.names, (n) => `<span class="set-provider${norm(n) === norm(cur) ? ' active' : ''}" data-act="setSearchProvider" data-arg="${esc(n)}" style="cursor:pointer">${esc(n)}</span>`)}</div>`;
      }
      case 'endpoint':
        return `<div class="set-endpoint"><span class="ico" style="background:${r.iconBg};color:${r.iconColor}">${esc(r.glyph)}</span><div style="min-width:0;flex:1"><div class="nm">${esc(r.name)}</div><div class="det">${esc(r.detail)}</div></div><span class="st" style="color:${r.statusColor}"><span class="d" style="background:${r.statusColor}"></span>${esc(r.status)}</span></div>`;
      case 'toggleRow':
        return `<div class="set-toggle-row" data-act="toggleUi" data-arg="${r.key}"><div style="min-width:0;flex:1"><div class="lbl">${esc(r.label)}</div>${r.desc ? `<div class="dsc">${esc(r.desc)}</div>` : ''}</div>${toggle(!!ui[r.key])}</div>`;
      case 'vis':
        return `<div class="set-vis">${map(r.items, ([key, label, hint]) => `<div class="set-vis-item" data-act="toggleUi" data-arg="${key}"><div style="min-width:0;flex:1"><span class="lbl">${esc(label)}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>${toggle(!!ui[key], true)}</div>`)}</div>`;
      case 'shortcut':
        return `<div class="set-shortcut"><span class="act">${esc(r.action)}</span>${map(r.keys, (k) => `<span class="set-key">${esc(k)}</span>`)}</div>`;
      case 'user':
        return `<div class="set-user"><span class="av">${esc(r.av)}</span><div style="flex:1"><div class="nm">${esc(r.name)}</div><div class="rl">${esc(r.role)}</div></div><span class="edit">Edit</span></div>`;
      case 'projects': {
        const list = s.live?.projects;
        if (!Array.isArray(list)) return '<div class="set-text set-live-empty">Projects haven’t loaded yet.</div>';
        const act = list.filter((p) => !p.archived).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        const arch = list.filter((p) => p.archived).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        const row = (p) => `<div class="set-proj-row"><span class="nm">${esc(p.name)}</span>`
          + `<button class="set-btn" data-act="renameProject" data-arg="${esc(p.id)}">Rename</button>`
          + (p.archived
            ? `<button class="set-btn" data-act="unarchiveProject" data-arg="${esc(p.id)}">Unarchive</button>`
            : `<button class="set-btn" data-act="archiveProject" data-arg="${esc(p.id)}">Archive</button>`)
          + `<button class="set-btn danger" data-act="deleteProject" data-arg="${esc(p.id)}">Delete</button></div>`;
        return (act.length ? map(act, row) : '<div class="set-text">No active projects. Run the backfill to seed the starter list.</div>')
          + (arch.length ? `<div class="set-row-head" style="margin-top:10px">Archived</div>${map(arch, row)}` : '');
      }
      case 'text':
        return `<div class="set-text">${esc(r.text)}</div>`;
      case 'accent': {
        const SWATCHES = ['#4fe3d1','#7bb6ff','#5bd97f','#a99bf5','#f0726a','#e8c268','#f97ab8','#67c4e3','#ff9850','#c6e847'];
        const isCustom = !SWATCHES.includes(accent);
        return `<div class="set-accents">
          ${map(SWATCHES, (hex) => {
            const on = accent === hex;
            return `<div class="set-accent" data-act="setAccent" data-arg="${hex}" style="background:${hex};box-shadow:0 0 0 ${on ? '3px' : '0px'} ${hex}55">${on ? icon('<path d="M20 6 9 17l-5-5"/>', { size: 17, sw: 3, stroke: '#0c1413' }) : ''}</div>`;
          })}
          <label class="set-accent-custom${isCustom ? ' on' : ''}" title="Custom hex color" style="position:relative;cursor:pointer">
            <input type="color" value="${esc(isCustom ? accent : '#4fe3d1')}" style="opacity:0;position:absolute;inset:0;width:100%;height:100%;cursor:pointer" data-act-color="setAccent">
            <span>${isCustom ? '✓' : '+'}</span>
          </label>
        </div>`;
      }
      default:
        return '';
    }
  };

  const renderCard = (c) => {
    const hasHeadExtra = c.sub || (c.rows && c.rows.length) || c.launcher || c.toggleKey;
    return `<div class="set-card${c.danger ? ' danger' : ''}">
      <div class="set-card-head${hasHeadExtra ? '' : ' tight'}">
        <span class="ico">${icon(c.icon, { size: 14, sw: 1.8 })}</span>
        <span class="t">${esc(c.title)}</span>
        ${c.note ? `<span class="note">${esc(c.note)}</span>` : ''}
        ${c.toggleKey ? `<div style="margin-left:auto" data-act="toggleUi" data-arg="${c.toggleKey}">${toggle(!!ui[c.toggleKey])}</div>` : ''}
      </div>
      ${c.sub ? `<div class="set-sub">${esc(c.sub)}</div>` : ''}
      ${(c.rows || []).map(renderRow).join('')}
      ${c.launcher ? `<button class="set-launcher"${c.launcherAct ? ` data-act="${c.launcherAct}"` : ''}>${esc(c.launcher)}</button>` : ''}
      ${(c.scheduledPanel && s.live && s.live.cron) ? cronPanel(s.live.cron) : ''}
      ${(c.brainPanel && s.live && s.live.brain) ? brainPanel(s.live.brain) : ''}
    </div>`;
  };

  const cards = (PANELS[sec] || []).map(renderCard).join('');
  return `
  <div class="split-h">
    <div class="set-nav">${nav}</div>
    <div class="set-content">
      <div class="set-head"><span class="t">${esc(TAB[sec][0])}</span><span class="d">${esc(TAB[sec][1])}</span></div>
      <div class="set-scroll"><div class="col">${cards}</div></div>
    </div>
  </div>`;
}

// ===========================================================================
// DISPATCH
// ===========================================================================
export function renderCenter(s) {
  switch (s.surface) {
    case 'chat': return chatSurface(s);
    case 'email': return emailSurface(s);
    case 'inbox': return inboxSurface(s);
    case 'calendar': return calendarSurface(s);
    case 'research': return researchSurface(s);
    case 'library': return librarySurface(s);
    case 'notes': return notesSurface(s);
    case 'settings': return settingsSurface(s);
    default: return chatSurface(s);
  }
}
