// Mobile surface renderers (phone shell). Reuse the shared data from ../data.js;
// only chrome/layout differs from desktop.

import { I, icon, fortress } from '../icons.js';
import { esc, map, when, stripMd } from '../dom.js';
import { AVATAR } from '../data.js';
import { QUICK_CHIPS } from '../surfaces.js';
import { MORE_CARDS } from './mobile-data.js';
import { renderActivity } from '../chat-activity.js';
import { renderChatStrip } from '../chat-strip.js';
import { renderMarkdown } from '../markdown.js';
import { providerLogo } from '../provider-logo.js';
import { cardButtonsHtml, chipRowHtml, filterVisible, isInvite, sourceCounts, triageSummary, triageSummaryText, bodyIsPath } from '../live/inbox-logic.js';
import { detailEndpoint } from '../live/inbox-detail.js';
import { assistantToolbar, userSheet } from './mobile-msg-tools.js';

const ic = {
  mic: () => icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', { size: 17, sw: 1.8 }),
  dots: () => icon('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>', { size: 22, sw: 2 }),
  back: () => icon('<path d="m15 18-6-6 6-6"/>', { size: 22, sw: 2.2 }),
  archive: () => icon('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>', { size: 20, sw: 2 }),
  chev: () => icon('<path d="m9 18 6-6-6-6"/>', { size: 18, sw: 2, stroke: 'var(--faint)' }),
};

// ---- bottom tab bar -------------------------------------------------------
export function renderTabBar(s) {
  const inboxItems = s.live?.inbox?.items || [];
  const inboxN = inboxItems.filter((m) => !s.dismissed.includes(String(m.id))).length;
  const tab = (id, label, iconHtml, badge) => {
    const active = s.mTab === id && !s.mSub;
    return `<button class="m-tab${active ? ' active' : ''}" data-act="mGo" data-arg="${id}">
      ${iconHtml}${badge || ''}<span class="lbl">${esc(label)}</span></button>`;
  };
  return `
  <div class="m-tabbar">
    ${tab('chat', 'Chat', I.chat(22))}
    ${tab('inbox', 'Inbox', I.inbox(22), inboxN ? `<span class="m-tab-badge">${inboxN}</span>` : '')}
    <div class="m-tab-add"><button class="m-add-btn" data-act="mNewChat" aria-label="New chat — hold for quick capture">${icon('<path d="M12 5v14M5 12h14"/>', { size: 24, sw: 2.4 })}<span class="m-add-caret">${icon('<path d="m18 15-6-6-6 6"/>', { size: 9, sw: 3.4 })}</span></button></div>
    ${tab('email', 'Email', I.email(22))}
    <button class="m-tab${s.mTab === 'more' ? ' active' : ''}" data-act="mGo" data-arg="more">${ic.dots()}<span class="lbl">More</span></button>
  </div>`;
}

// one mobile chat message → html (live thread item: {role,time,model,text,activity?})
export function mChatMsg(m, s) {
  const hasText = String(m.text || '').trim().length > 0;
  // Assistant text is markdown — render it the same way the desktop thread does
  // (headings, lists, bold, links, code) instead of dumping raw markup as plain text.
  const paras = hasText ? renderMarkdown(m.text) : '';
  if (m.role === 'user' && m.sys) {
    return `<div class="msg-sys" data-msg-id="${esc(m.id)}"><span class="msg-sys-txt">${esc(m.text)}</span></div>`;
  }
  if (m.role === 'user') {
    const attachHtml = (m.attach && m.attach.length) ? m.attach.map((a) => {
      const isImg = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(a.name || '');
      return isImg && a.url
        ? `<img class="m-attach-img" src="${esc(a.url)}" alt="${esc(a.name || 'image')}">`
        : `<span class="m-attach-chip">📎 ${esc(a.name || a.id)}</span>`;
    }).join('') : '';
    const pending = !!(m._optimistic && m._deadline);
    const ring = pending ? `<span class="m-msg-pending-ring" title="Sending…"></span>` : '';
    const chip = pending ? `<button class="m-msg-edit-chip" data-act="editPendingOnMobile" data-arg="${esc(m.id)}">Tap to edit</button>` : '';
    const meta = pending ? `<div class="m-msg-user-meta">${ring}${chip}</div>` : '';
    return `<div class="m-msg-user-wrap" data-msg-id="${esc(m.id)}"><div class="m-msg-user">${attachHtml ? `<div class="m-msg-attachments">${attachHtml}</div>` : ''}${esc(m.text || '')}</div>${meta}</div>`;
  }
  const streamAttr = m.streaming ? ' data-streaming="1"' : '';
  const updateBlocksHtml = (() => {
    const blocks = m.updateBlocks;
    if (!Array.isArray(blocks) || !blocks.length) return '';
    return blocks.map((b) => {
      const mins = Math.max(0, Math.round((b.elapsed_ms || 0) / 60000));
      const lbl = mins < 1 ? 'just now' : `${mins}m later`;
      const hdr = `<div class="m-turn-update-header">↳ update, ${esc(lbl)}</div>`;
      let content = '';
      if (b.payload && b.payload.image_url) {
        content = `<img class="m-turn-update-image" src="${esc(b.payload.image_url)}" alt="${esc(b.payload.alt_text || '')}" onclick="window.open(this.src,'_blank')">`;
      } else if (b.payload && b.payload.error) {
        content = `<div class="m-turn-update-error">${esc(b.payload.error)}</div>`;
      }
      return `<div class="m-turn-update-block">${hdr}${content}</div>`;
    }).join('');
  })();
  const pendingPillHtml = (() => {
    const tokens = m.pendingTokens;
    if (!Array.isArray(tokens) || !tokens.length) return '';
    const n = tokens.length;
    const title = tokens.map((t) => `${t.kind} · ${t.label}`).join('\n');
    return `<span class="m-turn-pending-pill" title="${esc(title)}"><span class="m-turn-pending-spin">${fortress(14)}</span>${n === 1 ? 'pending' : n}</span>`;
  })();
  // Failed-turn notice — same safeguard as the desktop thread (surfaces.js
  // chatMsg): never leave an errored turn as a silent blank bubble.
  const notice = m.error
    ? `<div class="m-msg-error"><span aria-hidden="true">⚠</span><span>${esc(m.notice || 'No response from this model.')}</span></div>`
    : '';
  return `<div class="m-msg-asst" data-msg-id="${esc(m.id)}"${streamAttr}>`
    + `<div class="m-msg-av"><img src="${AVATAR}" alt="__AGENT_NAME__"></div>`
    + `<div class="m-md" style="min-width:0">${renderActivity(m, s)}${paras}${notice}${updateBlocksHtml}${pendingPillHtml}${assistantToolbar(m, s)}</div>`
  + `</div>`;
}

// Pull-to-refresh indicator. Any .m-scroll marked data-ptr="1" with this as its
// first child becomes pullable (see wireMobileGestures); refresh() re-fetches
// whatever surface is active, so the markup is all each surface needs.
const mPtr = (s, label = 'Refreshing…') => `<div class="m-ptr${s.refreshing ? ' open' : ''}" style="height:${s.refreshing ? 'auto' : '0'}"><span class="spin">${fortress(20)}</span>${when(s.refreshing, `<span class="lbl">${label}</span>`)}</div>`;

// Bottom pull-to-refresh indicator — the mirror of mPtr, anchored to the END of
// a bottom-pinned feed (chat). A .m-scroll marked data-ptr-btm="1" with this as
// its LAST child rubber-bands and refreshes when you keep dragging up past the
// newest message (see wireMobileGestures). Easier to reach than the top pull.
const mPtrBtm = (s, label = 'Refreshing chat…') => `<div class="m-ptr-btm${s.refreshing ? ' open' : ''}" style="height:${s.refreshing ? 'auto' : '0'}"><span class="spin">${fortress(20)}</span>${when(s.refreshing, `<span class="lbl">${label}</span>`)}</div>`;

// ---- chat -----------------------------------------------------------------
export function mChat(s) {
  const focused = s.keyboard;
  const thread = s.live?.chat?.thread || [];
  const model = s.live?.chat?.model || '';
  const modelLogo = providerLogo(s.live?.chat?.endpointId, model);
  // Friendly model name (e.g. "Opus 4.8") from the live model list, matching the
  // desktop header's currentModelLabel; falls back to the raw id.
  let modelLabel = model;
  const _ml = s.live?.modelList;
  if (_ml && _ml.length) {
    const _curId = (s.live?.chat?.endpointId || '') + '·' + (model || '');
    const _hit = _ml.find((m) => m.id === _curId) || _ml.find((m) => m.mid === model);
    if (_hit && _hit.name) modelLabel = _hit.name;
  }
  const chips = QUICK_CHIPS.map((c) =>
    `<button class="qchip occhip" data-act="fillComposer" data-arg="${esc(c.prompt)}">${esc(c.label)}</button>`
  ).join('');
  const mWelcome = `<div class="chat-welcome">
    <div class="cw-av"><img src="${AVATAR}" alt="__AGENT_NAME__"></div>
    <div class="cw-name">__AGENT_NAME__</div>
    <div class="cw-hint">Type a message below &nbsp;·&nbsp; <kbd>/</kbd> for commands</div>
    <div class="cw-chips">${chips}</div>
  </div>`;
  const threadHtml = thread.length ? map(thread, (msg) => mChatMsg(msg, s)) : mWelcome;
  // composing layout: keyboard up, tab bar hidden (handled by shell), composer lifts
  const sheetId = s.live?.chat?.mobileSheetMsgId;
  const sheetMsg = sheetId ? (thread.find((m) => m.id === sheetId) || null) : null;
  const sheetHtml = sheetMsg ? userSheet(sheetMsg, s) : '';
  return `
  <div class="m-head">
    <div class="m-gary">
      <button class="m-icon-btn m-hide-kb m-nav-btn" data-act="openConvSheet" title="Chats" aria-label="Chats">${icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', { size: 18, sw: 1.9 })}</button>
      <button class="m-gary-id" data-act="openConvSheet" title="Switch conversation">
        <div class="m-conv-title"><span class="t">${esc(s.live?.chat?.title || 'New chat')}</span></div>
        <div class="m-conv-sub"><span class="dot"></span>__AGENT_NAME__ · online</div>
      </button>
      <button class="m-model-chip ocbtn" data-act="openModelSheet" title="Switch model"><span class="model-provider-logo">${modelLogo}</span><span class="m-model-name">${esc(modelLabel || '…')}</span></button>
    </div>
  </div>
  <div class="m-comp-handle m-hide-kb"><div class="pill" data-act="openCompanion">${icon('<path d="m4 17 6-6-6-6M12 19h8"/>', { size: 13, sw: 1.9, stroke: 'var(--gold)' })}<span class="t">Terminal · Files</span><span class="up">▲ pull up</span></div></div>
  <div class="m-scroll m-thread${thread.length ? '' : ' empty'}" data-ptr="1" data-ptr-btm="1">${mPtr(s, 'Refreshing chat…')}${threadHtml}${mPtrBtm(s, 'Refreshing chat…')}</div>
  <button class="m-scroll-btm" data-act="scrollChatBottom" title="Jump to latest" style="display:none;bottom:calc(env(safe-area-inset-bottom,0px) + 122px)">${icon('<path d="M12 5v14M19 12l-7 7-7-7"/>', { size: 18, sw: 2 })}</button>
  <div class="m-composer${focused ? ' focused' : ''}">
    ${renderChatStrip(s.live?.chat?.chatStrip, { renderMarkdown })}
    ${when(s.mobileEditingPending, `<div class="m-comp-edit-chip"><span class="m-comp-edit-lbl">Editing message</span><button class="m-comp-edit-cancel" data-act="cancelMobileEdit">Cancel</button></div>`)}
    ${when(s.live?.chat?.queued, `<div class="m-queued" data-act="queueRecall"><span class="q-ico">⏳</span><span class="q-txt">Queued${s.live?.chat?.queued?.text ? ` · ${esc(s.live.chat.queued.text.slice(0, 50))}` : ' · image'}</span><button class="m-q-x" data-act="queueCancel">✕</button></div>`)}
    ${when(s.pendingAttach && s.pendingAttach.length, `<div class="m-attach-row">${map(s.pendingAttach || [], (a) => `<span class="m-attach-chip"><span class="nm">${esc(a.name || a.id)}</span><span class="x" data-act="removeAttach" data-arg="${esc(a.id)}">✕</span></span>`)}</div>`)}
    <div class="bar">
      <label class="m-round-btn bordered" title="Attach photo or file"><input type="file" data-upload multiple style="display:none">${I.plus(16)}</label>
      <textarea data-model="draft" data-focus="mdraft" rows="1" placeholder="Message __AGENT_NAME__…">
${esc(s.draft || '')}</textarea>
      <button class="m-round-btn m-hide-kb">${ic.mic()}</button>
      <button class="m-send${s.mobileEditingPending ? ' editing' : ''}" data-act="send">${I.send(16)}${s.mobileEditingPending ? `<span class="m-send-lbl">Save</span>` : ''}</button>
    </div>
  </div>
  ${sheetHtml}`;
}

// ---- inbox ----------------------------------------------------------------
export function mInbox(s) {
  const items = s.live?.inbox?.items || [];
  const visible = filterVisible(items, { dismissed: s.dismissed, filter: s.inboxFilter });
  const needs = visible.filter((m) => m.group === 'needs');
  const fyi = visible.filter((m) => m.group === 'fyi');

  const mBodyAttr = (it) => detailEndpoint(it) ? ` data-act="openReader" data-arg="${esc(it.id)}" style="cursor:pointer"` : '';
  // Ingest source pointers render as a dim mono line, not as body prose.
  const mBodyInner = (it) => bodyIsPath(it.body)
    ? `<span class="body-src">${esc(it.body)}</span>` : esc(stripMd(it.body));
  // swipeable card (NEEDS YOU); offset driven by s.swipe for the active id
  const swipeCard = (it) => {
    const off = (s.swipe && s.swipe.id === it.id) ? s.swipe.dx : 0;
    // Invites don't auto-act on a right swipe (no accidental "Yes" → organizer
    // email) — the hint tells the user to tap a button instead.
    const rightHint = isInvite(it)
      ? '📅<span>Tap Yes / Maybe / No</span>'
      : '✓<span>Action</span>';
    return `
    <div class="m-swipe" data-swipe-id="${it.id}">
      <div class="m-swipe-bg">
        <div class="act act-right">${rightHint}</div>
        <div class="act act-left">✕<span>Dismiss · ⏰</span></div>
      </div>
      <div class="m-swipe-card${off ? ' swiping' : ' snap'}" data-swipe-card="${it.id}" style="transform:translateX(${off}px)">
        <div class="top"><span class="m-src" style="color:${it.srcColor};background:${it.srcBg}">${esc(it.src)}</span><span class="who">${esc(stripMd(it.who))}</span><span class="ago">· ${esc(it.time)}</span>${when(it.unread, '<span class="udot"></span>')}</div>
        <div class="body"${mBodyAttr(it)}>${mBodyInner(it)}</div>
        <div class="actions">${cardButtonsHtml(it, esc, { moreOpen: s.inboxMoreFor === it.id })}</div>
      </div>
    </div>`;
  };
  const fyiCard = (it) => `
    <div class="m-card fyi">
      <div class="top"><span class="m-src" style="color:${it.srcColor};background:${it.srcBg}">${esc(it.src)}</span><span class="who">${esc(stripMd(it.who))}</span><span class="ago">· ${esc(it.time)}</span></div>
      <div class="body"${mBodyAttr(it)}>${mBodyInner(it)}</div>
      <button class="m-ai-pill" data-act="applyRec" data-arg="${it.id}">✦ ${esc(it.suggest)}</button>
      <div class="actions">${cardButtonsHtml(it, esc, { moreOpen: s.inboxMoreFor === it.id })}</div>
    </div>`;

  const mReaderBody = (r) => {
    if (!r) return '';
    if (r.loading) return `<div class="ird-loading" style="padding:20px;color:var(--faint)">Loading…</div>`;
    if (r.error) return `<div style="padding:16px;color:var(--red)">${esc(r.error)}</div>`;
    const d = r.data || {};
    if (r.kind === 'slack') {
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      return `<div class="ird-slack-thread" style="padding:12px 16px">${msgs.map((m) =>
        `<div style="margin-bottom:10px"><b style="font-size:12px;color:var(--faint)">${esc(String(m.user || m.username || ''))}</b><div style="font-size:13px;line-height:1.5">${esc(String(m.text || ''))}</div></div>`
      ).join('')}${!msgs.length ? '<div style="color:var(--faint)">No messages.</div>' : ''}</div>`;
    }
    if (r.kind === 'asana') {
      const notes = esc(String(d.notes || '')).replace(/\n/g, '<br>');
      const assignee = d.assignee && (d.assignee.name || d.assignee) ? esc(String(d.assignee.name || d.assignee)) : null;
      const due = d.due_on ? esc(String(d.due_on)) : null;
      return `<div style="padding:12px 16px;font-size:13px">
        ${when(assignee, `<div style="margin-bottom:6px;color:var(--faint)">Assignee: <b style="color:var(--fg)">${assignee}</b></div>`)}
        ${when(due, `<div style="margin-bottom:6px;color:var(--faint)">Due: <b style="color:var(--fg)">${due}</b></div>`)}
        ${notes ? `<div style="white-space:pre-wrap;line-height:1.5">${notes}</div>` : ''}
      </div>`;
    }
    if (r.kind === 'gmail') {
      const rawBody = d.body || d.body_html || '';
      const isHtml = /<[a-z!][\s\S]*>/i.test(String(rawBody));
      let text = String(rawBody);
      if (isHtml) {
        text = text
          .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
          .replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(p|div|li|h[1-6])\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
          .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      const paras = text.split(/\n\n+/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
      return `<div style="padding:12px 16px;font-size:13px;line-height:1.6">${paras.map((p) => `<p style="margin:0 0 10px">${esc(p)}</p>`).join('')}</div>`;
    }
    return `<div style="padding:16px;color:var(--faint)">No content.</div>`;
  };

  const inboxReaderSheet = s.inboxReader ? (() => {
    const r = s.inboxReader;
    const item = items.find((m) => m.id === r.id) || {};
    const title = item.who || r.id || 'Detail';
    return `
    <div class="m-sheet-scrim" data-act="closeReader" aria-hidden="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:50"></div>
    <div class="m-sheet" data-modal="reader" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="position:fixed;left:0;right:0;bottom:0;max-height:80vh;background:var(--panel,#1e2025);border-radius:16px 16px 0 0;display:flex;flex-direction:column;z-index:51;overflow:hidden">
      <div style="display:flex;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
        <span style="font-weight:600;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</span>
        <button type="button" class="icon-btn ocbtn" data-act="closeReader" aria-label="Close" style="background:none;border:none;cursor:pointer;color:var(--faint);font-size:17px;line-height:1;padding:2px 6px">✕</button>
      </div>
      <div style="overflow-y:auto;flex:1">${mReaderBody(r)}</div>
    </div>`;
  })() : '';

  return `
  <div class="m-head">
    <div class="m-head-row"><span class="m-title">Inbox</span><span class="m-title-sub">${visible.length} to triage</span><div class="m-spacer"></div><button class="m-triage" data-act="triageAll">✦ Triage</button></div>
    <div class="m-head-row" style="margin-top:11px;gap:7px">
      ${chipRowHtml(sourceCounts(items, { dismissed: s.dismissed }, s.live?.inbox?.sources), { filter: s.inboxFilter, errors: s.live?.inbox?.errors || {} }, esc)}
    </div>
    ${(() => {
      if (!s.inboxTriaged || s.inboxTriageReviewed) return '';
      const sum = triageSummary(items, s.dismissed || []);
      if (!sum.total) return '';
      return `<div class="triage-summary" style="margin-top:11px">
        <span class="ts-label">✦ suggests: ${esc(triageSummaryText(sum.counts))}</span>
        <div class="m-spacer"></div>
        <button class="btn-sm" data-act="applyAll">Apply all</button>
        <button class="btn-sm ghost" data-act="reviewTriage">Review</button>
      </div>`;
    })()}
  </div>
  <div class="m-scroll m-feed" data-ptr="1">
    ${mPtr(s, 'Checking for new…')}
    ${when(needs.length > 0, `<div class="m-grp needs">NEEDS YOU · ${needs.length}</div>${map(needs, swipeCard)}`)}
    ${when(fyi.length > 0, `<div class="m-grp fyi">AI-SUGGESTED · FYI · ${fyi.length}</div>${map(fyi, fyiCard)}`)}
    ${when(visible.length === 0, `<div class="inbox-zero" style="padding:60px 0"><div class="ico">${I.check()}</div><div class="t">Inbox zero</div><div class="d">__AGENT_NAME__ cleared the feed.</div></div>`)}
  </div>
  ${inboxReaderSheet}
  ${s.inboxToast ? `
    <div class="inbox-toast" style="position:fixed;bottom:80px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:var(--panel,#1e2025);border:1px solid var(--border);border-radius:8px;padding:10px 14px;box-shadow:0 4px 20px rgba(0,0,0,.4);z-index:80;white-space:nowrap;max-width:90vw">
      <span>${esc(s.inboxToast.msg)}</span>
      ${(s.inboxToast.undoTs || s.inboxToast.undoLocal || (s.inboxToast.undoBatch && s.inboxToast.undoBatch.length)) ? `<button class="btn-sm" data-act="undo">Undo</button>` : ''}
      <span data-act="dismissToast" style="cursor:pointer;color:var(--faint);margin-left:4px">✕</span>
    </div>` : ''}`;
}

// ---- email list -----------------------------------------------------------
export function mEmailList(s) {
  const emails = s.live?.email?.emails || [];
  const emailUnread = emails.filter((e) => e.unread).length;
  // Same filter as the desktop list (surfaces.js emailSurface): subject,
  // sender, and source, case-insensitive. Keep original indexes for mOpenReader.
  const q = (s.emailQuery || '').trim().toLowerCase();
  const shown = emails.map((e, i) => ({ e, i }))
    .filter(({ e }) => !q || `${e.subj || ''} ${e.from || ''} ${e.src || ''}`.toLowerCase().includes(q));
  const emptyMsg = emails.length === 0
    ? 'No mail here yet.'
    : `No matches for “${esc(s.emailQuery || '')}”.`;
  return `
  <div class="m-head">
    <div class="m-head-row"><span class="m-title">Email</span>${emailUnread > 0 ? `<span class="pill-teal">${emailUnread} unread</span>` : ''}<div class="m-spacer"></div><button class="m-icon-btn" data-act="composeNew" aria-label="New message">${I.plus(16)}</button></div>
    <div class="m-search">${I.search()}<input data-model="emailQuery" data-focus="emailQuery" placeholder="Search · INBOX" value="${esc(s.emailQuery || '')}" autocomplete="off"></div>
  </div>
  <div class="m-scroll m-mail-list" data-ptr="1">
    ${mPtr(s, 'Checking mail…')}
    ${shown.length ? map(shown, ({ e, i }) => {
      const snippet = (e.body && e.body[0]) ? e.body[0] : '';
      return `<div class="m-mail${s.mEmailOpened && i === s.selEmail ? ' active' : ''}" data-act="mOpenReader" data-arg="${i}">
        <div class="top"><span class="m-src" style="color:${e.srcColor};background:${e.srcBg}">${esc(e.src)}</span>${when(e.unread, '<span class="udot"></span>')}<span class="time">${esc(e.time)}</span></div>
        <div class="subj${e.unread ? ' bold' : ''}">${esc(e.subj)}</div>
        <div class="snip">${esc(e.from)}${snippet ? ` · ${esc(snippet)}` : ''}</div>
      </div>`;
    }) : `<div class="m-mail-empty">${emptyMsg}</div>`}
  </div>`;
}

// ---- email reader (pushed, no tab bar) ------------------------------------
export function mEmailReader(s) {
  const emails = s.live?.email?.emails || [];
  const m = s.live?.email?.current ?? emails[s.selEmail] ?? {};
  const attach = m.attach || [];
  const replyTo = (m.from || '').split(' ')[0];
  return `
  <div class="m-head" style="display:flex;align-items:center;gap:6px;padding-left:12px;padding-right:12px">
    <button class="m-back" data-act="mCloseReader">${ic.back()}<span>Email</span></button>
    <div class="m-spacer"></div>
  </div>
  <div class="m-scroll m-reader">
    <h1>${esc(m.subj)}</h1>
    <div class="m-reader-from"><div class="m-reader-av" style="background:${m.avBg};color:${m.avFg}">${esc(m.initials)}</div><div style="min-width:0"><div class="nm">${esc(m.from)}</div><div class="to">to me · ${esc(m.time)}</div></div></div>
    <div class="m-ai-row"><button class="m-ai-btn teal" data-act="composeAiDraft">✦ AI reply</button><button class="m-ai-btn violet" data-act="summarizeEmail">✦ Summarize</button></div>
    ${when(s.emailSummary, `<div class="m-email-summary"><div class="hd"><span class="t">✦ Summary</span><button class="x" data-act="clearEmailSummary" aria-label="Dismiss summary">✕</button></div><div class="bd">${esc(s.emailSummary)}</div></div>`)}
    ${map(m.body || [], (p) => `<p>${esc(p)}</p>`)}
    ${map(attach, (a) => `<div class="m-attach"><span class="ico">${I.file(15, 'currentColor')}</span><div><div class="nm">${esc(a.name)}</div><div class="sz">${esc(a.size)}</div></div></div>`)}
  </div>
  <div class="m-reply-bar"><div class="box" data-act="composeReply" data-arg="reply"><span class="ph">Reply to ${esc(replyTo)}…</span><button class="m-draft" data-act="composeAiDraft">✦ Draft</button><button class="m-send" data-act="composeReply" data-arg="reply" style="width:32px;height:32px">${I.send(15)}</button></div></div>`;
}

// ---- calendar agenda (under More) -----------------------------------------
export function mCalendar(s) {
  const event = (e) => `
    <div class="m-ev"><span class="time ${e.time === 'all-day' ? 'dim' : 'lit'}">${esc(e.time)}</span>
      <div class="det" style="border-left-color:${e.tone}"><div class="t">${esc(e.title)}</div>${e.sub ? `<div class="s">${esc(e.sub)}</div>` : ''}</div></div>`;
  const group = (g, i) => `
    <div class="m-agenda-grp${i > 0 ? ' next' : ''}"><span class="lbl ${i === 0 ? 'today' : 'dim'}">${esc(g.label)}</span>${g.tag ? `<span class="tag" style="color:${g.tagColor}">${esc(g.tag)}</span>` : ''}<div class="rule"></div></div>
    ${map(g.events, event)}`;
  // Live data only — a failed/pending calendar load shows an empty state, never
  // the mock sample week. Month + year both derive from the live month label.
  const week = s.live?.calendar?.week || [];
  const agenda = s.live?.calendar?.agenda || [];
  const [monthLabel, yearLabel] = String(s.live?.calendar?.month || '').split(' ');
  return `
  <div class="m-head">
    <div class="m-head-row"><button class="m-back" data-act="mBackToHub">${ic.back()}</button><span class="m-title">${esc(monthLabel || 'Calendar')}</span><span class="m-title-sub">${esc(yearLabel || '')}</span><div class="m-spacer"></div><div class="m-seg"><span class="active">Agenda</span></div></div>
    <div class="m-week">
      ${map(week, (w) => `<div class="col"><span class="dl${w.today ? ' today' : ''}">${w.d}</span><span class="dn${w.today ? ' today' : ''}">${w.date}</span></div>`)}
    </div>
  </div>
  <div class="m-scroll m-agenda" data-ptr="1">${mPtr(s, 'Refreshing…')}${agenda.length ? map(agenda, group) : '<div class="m-agenda-empty">No events in the next 7 days.</div>'}</div>
  <div class="m-quickadd"><div class="box"><span class="star">✦</span><input data-model="quick" data-focus="mquick" placeholder="&quot;feed Krypto 1pm tmrw&quot;" value="${esc(s.quick || '')}"/><button class="add" data-act="clearQuick">${I.plus(15)}</button></div></div>`;
}

// ---- More hub -------------------------------------------------------------
// Card counts come from live state — no count renders until its surface's data
// has actually loaded (MORE_CARDS carries only id/name/icon).
function moreCount(s, id) {
  switch (id) {
    case 'calendar': {
      const ag = s.live?.calendar?.agenda;
      if (!ag) return '';
      const n = String(ag[0]?.label || '').startsWith('TODAY') ? (ag[0].events || []).length : 0;
      return `${n} event${n === 1 ? '' : 's'} today`;
    }
    case 'research': { const p = s.live?.research?.past; return p ? `${p.length} report${p.length === 1 ? '' : 's'}` : ''; }
    case 'library': { const a = s.live?.library?.items; return a ? `${a.length} artifact${a.length === 1 ? '' : 's'}` : ''; }
    case 'notes': { const d = s.live?.notes?.docs; return d ? `${d.length} in vault` : ''; }
    case 'settings': return '14 sections';
    default: return '';
  }
}
export function mMore(s) {
  return `
  <div class="m-head"><span class="m-title">More</span></div>
  <div class="m-scroll m-more">
    <div class="m-gary-card"><div class="av"><img src="${AVATAR}" alt="__AGENT_NAME__"></div><div style="flex:1"><div class="nm">__AGENT_NAME__</div><div class="st"><span class="dot"></span>online · gateway healthy</div></div></div>
    <div class="m-grid">
      ${map(MORE_CARDS, (c) => `<div class="m-grid-card" data-act="mOpenSub" data-arg="${c.id}"><div class="ico" style="background:${c.iconBg};color:${c.iconColor}">${icon(c.icon, { size: 18, sw: 1.7 })}</div><div class="nm">${esc(c.name)}</div><div class="ct">${esc(moreCount(s, c.id))}</div></div>`)}
    </div>
    <a class="m-source-link" href="${esc(s.sourceUrl || 'https://github.com/frankramblings/openclaw-workspace')}" target="_blank" rel="noopener noreferrer">${I.code(14)}<span>View source · AGPL-3.0</span></a>
  </div>`;
}
