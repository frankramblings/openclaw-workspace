// Mobile surface renderers (phone shell). Reuse the shared data from ../data.js;
// only chrome/layout differs from desktop.

import { I, icon } from '../icons.js';
import { esc, map, when, stripMd } from '../dom.js';
import { AVATAR, EMAILS, INBOX } from '../data.js';
import { WEEK_STRIP, AGENDA, MORE_CARDS } from './mobile-data.js';
import { renderActivity } from '../chat-activity.js';
import { renderMarkdown } from '../markdown.js';

const ic = {
  mic: () => icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', { size: 17, sw: 1.8 }),
  dots: () => icon('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>', { size: 22, sw: 2 }),
  back: () => icon('<path d="m15 18-6-6 6-6"/>', { size: 22, sw: 2.2 }),
  archive: () => icon('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>', { size: 20, sw: 2 }),
  chev: () => icon('<path d="m9 18 6-6-6-6"/>', { size: 18, sw: 2, stroke: 'var(--faint)' }),
};

// ---- bottom tab bar -------------------------------------------------------
export function renderTabBar(s) {
  const inboxN = INBOX.filter((m) => !s.dismissed.includes(m.id)).length;
  const tab = (id, label, iconHtml, badge) => {
    const active = s.mTab === id && !s.mSub;
    return `<button class="m-tab${active ? ' active' : ''}" data-act="mGo" data-arg="${id}">
      ${iconHtml}${badge || ''}<span class="lbl">${esc(label)}</span></button>`;
  };
  return `
  <div class="m-tabbar">
    ${tab('chat', 'Chat', I.chat(22))}
    ${tab('inbox', 'Inbox', I.inbox(22), inboxN ? `<span class="m-tab-badge">${inboxN}</span>` : '')}
    <div class="m-tab-add"><button class="m-add-btn" data-act="openCapture">${icon('<path d="M12 5v14M5 12h14"/>', { size: 24, sw: 2.4 })}</button></div>
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
  if (m.role === 'user') return `<div class="m-msg-user-wrap" data-msg-id="${esc(m.id)}"><div class="m-msg-user">${esc(m.text || '')}</div></div>`;
  return `<div class="m-msg-asst" data-msg-id="${esc(m.id)}"><div class="m-msg-av"><img src="${AVATAR}" alt="Gary"></div><div class="m-md" style="min-width:0">${renderActivity(m, s)}${paras}</div></div>`;
}

// Pull-to-refresh indicator. Any .m-scroll marked data-ptr="1" with this as its
// first child becomes pullable (see wireMobileGestures); refresh() re-fetches
// whatever surface is active, so the markup is all each surface needs.
const mPtr = (s, label = 'Refreshing…') => `<div class="m-ptr" style="height:${s.refreshing ? 'auto' : '0'}">${when(s.refreshing, `<span class="spin"></span><span class="lbl">${label}</span>`)}</div>`;

// ---- chat -----------------------------------------------------------------
export function mChat(s) {
  const focused = s.keyboard;
  const thread = s.live?.chat?.thread || [];
  // Empty thread (new/cold chat) used to render a fully blank screen — show a
  // centered prompt instead, reusing the shared .inbox-zero empty-state shell.
  const threadHtml = thread.length
    ? map(thread, (msg) => mChatMsg(msg, s))
    : `<div class="inbox-zero m-chat-zero"><div class="ico"><img src="${AVATAR}" alt="Gary"></div><div class="t">Message Gary to start</div><div class="d">Ask anything — or pull up Terminal · Files above.</div></div>`;
  // composing layout: keyboard up, tab bar hidden (handled by shell), composer lifts
  return `
  <div class="m-head">
    <div class="m-gary">
      <div class="m-gav"><img src="${AVATAR}" alt="Gary"></div>
      <div style="flex:1;min-width:0"><div class="nm">Gary</div><div class="status"><span class="dot"></span>online · opus-4</div></div>
      ${when(!focused, `<button class="m-icon-btn" data-act="newChat" title="New chat">${I.plus(17)}</button>`)}
    </div>
  </div>
  ${when(!focused, `<div class="m-comp-handle"><div class="pill" data-act="openCompanion">${icon('<path d="m4 17 6-6-6-6M12 19h8"/>', { size: 13, sw: 1.9, stroke: 'var(--gold)' })}<span class="t">Terminal · Files</span><span class="up">▲ pull up</span></div></div>`)}
  <div class="m-scroll m-thread${thread.length ? '' : ' empty'}" data-ptr="1">${mPtr(s, 'Refreshing chat…')}${threadHtml}</div>
  <button class="m-scroll-btm" data-act="scrollChatBottom" title="Jump to latest" style="display:none;bottom:${focused ? '78px' : 'calc(env(safe-area-inset-bottom,0px) + 122px)'}">${icon('<path d="M12 5v14M19 12l-7 7-7-7"/>', { size: 18, sw: 2 })}</button>
  <div class="m-composer${focused ? ' focused' : ''}">
    ${when(s.pendingAttach && s.pendingAttach.length, `<div class="m-attach-row">${map(s.pendingAttach || [], (a) => `<span class="m-attach-chip"><span class="nm">${esc(a.name || a.id)}</span><span class="x" data-act="removeAttach" data-arg="${esc(a.id)}">✕</span></span>`)}</div>`)}
    <div class="bar">
      <label class="m-round-btn bordered" title="Attach photo or file"><input type="file" data-upload multiple style="display:none">${I.plus(16)}</label>
      <textarea data-model="draft" data-focus="mdraft" rows="1" placeholder="Message Gary…">${esc(s.draft || '')}</textarea>
      ${when(!focused, `<button class="m-round-btn">${ic.mic()}</button>`)}
      <button class="m-send" data-act="send">${I.send(16)}</button>
    </div>
  </div>`;
}

// ---- inbox ----------------------------------------------------------------
export function mInbox(s) {
  const items = s.live?.inbox?.items ?? INBOX;
  const visible = items.filter((m) => !s.dismissed.includes(m.id));
  const needs = visible.filter((m) => m.group === 'needs');
  const fyi = visible.filter((m) => m.group === 'fyi');
  const cnt = (src) => visible.filter((m) => m.src === src).length;

  // swipeable card (NEEDS YOU); offset driven by s.swipe for the active id
  const swipeCard = (it) => {
    const off = (s.swipe && s.swipe.id === it.id) ? s.swipe.dx : 0;
    return `
    <div class="m-swipe" data-swipe-id="${it.id}">
      <div class="m-swipe-bg"><div class="act">${ic.archive()}<span>Archive</span></div></div>
      <div class="m-swipe-card${off ? ' swiping' : ' snap'}" data-swipe-card="${it.id}" style="transform:translateX(${off}px)">
        <div class="top"><span class="m-src" style="color:${it.srcColor};background:${it.srcBg}">${esc(it.src)}</span><span class="who">${esc(stripMd(it.who))}</span><span class="ago">· ${esc(it.time)}</span>${when(it.unread, '<span class="udot"></span>')}</div>
        <div class="body">${esc(stripMd(it.body))}</div>
        <div class="actions"><button class="m-pill" data-act="dismiss" data-arg="${it.id}">${esc(it.primary)}</button><button class="m-pill ghost" data-act="dismiss" data-arg="${it.id}">${esc(it.secondary)}</button></div>
      </div>
    </div>`;
  };
  const fyiCard = (it) => `
    <div class="m-card fyi">
      <div class="top"><span class="m-src" style="color:${it.srcColor};background:${it.srcBg}">${esc(it.src)}</span><span class="who">${esc(stripMd(it.who))}</span><span class="ago">· ${esc(it.time)}</span></div>
      <div class="body">${esc(stripMd(it.body))}</div>
      <div class="m-ai-pill">✦ ${esc(it.suggest)}</div>
      <div class="actions"><button class="m-pill" data-act="dismiss" data-arg="${it.id}">Archive</button><button class="m-pill ghost" data-act="dismiss" data-arg="${it.id}">Keep</button></div>
    </div>`;

  return `
  <div class="m-head">
    <div class="m-head-row"><span class="m-title">Inbox</span><span class="m-title-sub">${visible.length} to triage</span><div class="m-spacer"></div><button class="m-triage" data-act="triageAll">✦ Triage</button></div>
    <div class="m-head-row" style="margin-top:11px;gap:7px">
      <span class="m-chip active">All ${visible.length}</span>
      <span class="m-chip"><span class="dot" style="background:var(--red)"></span>gmail ${cnt('GMAIL')}</span>
      <span class="m-chip"><span class="dot" style="background:var(--green)"></span>slack ${cnt('SLACK')}</span>
    </div>
  </div>
  <div class="m-scroll m-feed" data-ptr="1">
    ${mPtr(s, 'Checking for new…')}
    ${when(needs.length > 0, `<div class="m-grp needs">NEEDS YOU · ${needs.length}</div>${map(needs, swipeCard)}`)}
    ${when(fyi.length > 0, `<div class="m-grp fyi">AI-SUGGESTED · FYI · ${fyi.length}</div>${map(fyi, fyiCard)}`)}
    ${when(visible.length === 0, `<div class="inbox-zero" style="padding:60px 0"><div class="ico">${I.check()}</div><div class="t">Inbox zero</div><div class="d">Gary cleared the feed.</div></div>`)}
  </div>`;
}

// ---- email list -----------------------------------------------------------
export function mEmailList(s) {
  const emails = s.live?.email?.emails ?? EMAILS;
  return `
  <div class="m-head">
    <div class="m-head-row"><span class="m-title">Email</span><span class="pill-teal">1 unread</span><div class="m-spacer"></div><button class="m-icon-btn">${I.plus(16)}</button></div>
    <div class="m-search">${I.search()}<span class="ph">Search · INBOX</span></div>
  </div>
  <div class="m-scroll m-mail-list" data-ptr="1">
    ${mPtr(s, 'Checking mail…')}
    ${map(emails, (e, i) => {
      const snippet = (e.body && e.body[0]) ? e.body[0] : '';
      return `<div class="m-mail${s.mEmailOpened && i === s.selEmail ? ' active' : ''}" data-act="mOpenReader" data-arg="${i}">
        <div class="top"><span class="m-src" style="color:${e.srcColor};background:${e.srcBg}">${esc(e.src)}</span>${when(e.unread, '<span class="udot"></span>')}<span class="time">${esc(e.time)}</span></div>
        <div class="subj${e.unread ? ' bold' : ''}">${esc(e.subj)}</div>
        <div class="snip">${esc(e.from)}${snippet ? ` · ${esc(snippet)}` : ''}</div>
      </div>`;
    })}
  </div>`;
}

// ---- email reader (pushed, no tab bar) ------------------------------------
export function mEmailReader(s) {
  const emails = s.live?.email?.emails ?? EMAILS;
  const m = s.live?.email?.current ?? emails[s.selEmail] ?? EMAILS[0];
  const attach = (m.attach || [])[0];
  const replyTo = (m.from || '').split(' ')[0];
  return `
  <div class="m-head" style="display:flex;align-items:center;gap:6px;padding-left:12px;padding-right:12px">
    <button class="m-back" data-act="mCloseReader">${ic.back()}<span>Email</span></button>
    <div class="m-spacer"></div>
    <button class="m-icon-btn" style="border:none">${ic.archive()}</button>
    <button class="m-icon-btn" style="border:none">${ic.dots()}</button>
  </div>
  <div class="m-scroll m-reader">
    <h1>${esc(m.subj)}</h1>
    <div class="m-reader-from"><div class="m-reader-av" style="background:${m.avBg};color:${m.avFg}">${esc(m.initials)}</div><div style="min-width:0"><div class="nm">${esc(m.from)}</div><div class="to">to me · ${esc(m.time)}</div></div></div>
    <div class="m-ai-row"><button class="m-ai-btn teal" data-act="composeAiDraft">✦ AI reply</button><button class="m-ai-btn violet" data-act="summarizeEmail">✦ Summarize</button></div>
    ${when(s.emailSummary, `<div class="m-email-summary"><div class="hd"><span class="t">✦ Summary</span><button class="x" data-act="clearEmailSummary" aria-label="Dismiss summary">✕</button></div><div class="bd">${esc(s.emailSummary)}</div></div>`)}
    ${map(m.body || [], (p) => `<p>${esc(p)}</p>`)}
    ${when(!!attach, `<div class="m-attach"><span class="ico">${I.file(15, 'currentColor')}</span><div><div class="nm">${esc(attach ? attach.name : '')}</div><div class="sz">${esc(attach ? attach.size : '')}</div></div></div>`)}
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
  const week = s.live?.calendar?.week ?? WEEK_STRIP;
  const agenda = s.live?.calendar?.agenda ?? AGENDA;
  const monthLabel = (s.live?.calendar?.month ?? 'June 2026').split(' ')[0];
  return `
  <div class="m-head">
    <div class="m-head-row"><button class="m-back" data-act="mBackToHub">${ic.back()}</button><span class="m-title">${esc(monthLabel)}</span><span class="m-title-sub">2026</span><div class="m-spacer"></div><div class="m-seg"><span class="active">Agenda</span></div></div>
    <div class="m-week">
      ${map(week, (w) => `<div class="col"><span class="dl${w.today ? ' today' : ''}">${w.d}</span><span class="dn${w.today ? ' today' : ''}">${w.date}</span></div>`)}
    </div>
  </div>
  <div class="m-scroll m-agenda" data-ptr="1">${mPtr(s, 'Refreshing…')}${map(agenda, group)}</div>
  <div class="m-quickadd"><div class="box"><span class="star">✦</span><input data-model="quick" data-focus="mquick" placeholder="&quot;return home to Ithaca 1pm tmrw&quot;" value="${esc(s.quick || '')}"/><button class="add" data-act="clearQuick">${I.plus(15)}</button></div></div>`;
}

// ---- More hub -------------------------------------------------------------
export function mMore(s) {
  return `
  <div class="m-head"><span class="m-title">More</span></div>
  <div class="m-scroll m-more">
    <div class="m-gary-card"><div class="av"><img src="${AVATAR}" alt="Gary"></div><div style="flex:1"><div class="nm">Gary</div><div class="st"><span class="dot"></span>online · gateway healthy</div></div></div>
    <div class="m-grid">
      ${map(MORE_CARDS, (c) => `<div class="m-grid-card" data-act="mOpenSub" data-arg="${c.id}"><div class="ico" style="background:${c.iconBg};color:${c.iconColor}">${icon(c.icon, { size: 18, sw: 1.7 })}</div><div class="nm">${esc(c.name)}</div><div class="ct">${esc(c.count)}</div></div>`)}
    </div>
  </div>`;
}
