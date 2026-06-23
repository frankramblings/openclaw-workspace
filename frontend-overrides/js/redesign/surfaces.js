// Per-surface center renderers for the redesign shell.
// Each returns an HTML string; interactivity is wired via data-act / data-model
// attributes handled by app.js event delegation.

import { I, icon } from './icons.js';
import { esc, map, when } from './dom.js';
import {
  AVATAR, SLASH_COMMANDS, RESEARCH_CONTROLS, RESEARCH_SCOPES, PAST_RESEARCH,
  LIBRARY, KIND_STYLE, LIB_FILTERS, NOTES, EMAILS, INBOX,
  CAL_MONTH, CAL_CELLS, CAL_BAR_TONE,
} from './data.js';
import { TAB, PANELS, NAV_GROUPS } from './settings-data.js';
import { renderActivity, MOCK_CHAT_THREAD } from './chat-activity.js';

// ===========================================================================
// CHAT
// ===========================================================================
export function renderChatList(s) {
  return `
  <div class="oc-secondary chat-list">
    <div class="chat-list-top">
      <button class="new-conv" data-act="newChat"><span class="plus">+</span> New conversation</button>
      <div class="oc-search" style="margin-top:10px">${I.search()}<input data-model="convFilter" data-focus="convFilter" placeholder="Filter conversations…" value="${esc(s.convFilter || '')}" autocomplete="off" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg);font-family:inherit"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:6px"><button data-act="cycleSessionSort" title="Sort order" style="background:none;border:none;color:var(--faint);font-size:11px;cursor:pointer">${s.convSort === 'alpha' ? 'A–Z' : 'Recent'} ⇅</button></div>
    </div>
    <div class="conv-scroll">${convListBody(s)}</div>
    <div class="conv-foot">${esc(s.live?.chat?.cwd ?? '/home/frank/.openclaw/workspace')}</div>
  </div>`;
}

// conversation rows: live sessions (grouped) with mock fallback
function convListBody(s) {
  const groups = s.live?.chat?.groups; // [{ label, rows:[{id,title,glyph,term,active}] }]
  if (!groups) {
    return `
      <div class="conv-group top"><span class="sect-label">TODAY</span></div>
      <div class="conv-row active"><span class="conv-badge">A\\</span><span class="conv-title">Workspace Streaming Chat</span></div>
      <div class="conv-row ocrow"><span class="conv-badge">A\\</span><span class="conv-title">Comedy Show Misogyny Check</span></div>
      <div class="conv-row ocrow"><span class="conv-badge">A\\</span><span class="conv-title">help me organize these thoughts</span></div>
      <div class="conv-group"><span class="sect-label">YESTERDAY</span></div>
      <div class="conv-row ocrow"><span class="conv-badge">A\\</span><span class="conv-title">Punny Names for OpenClaw</span></div>
      <div class="conv-row ocrow"><span class="conv-badge term">∿</span><span class="conv-title">Install Claude Code on Ubuntu</span></div>`;
  }
  const q = (s.convFilter || '').trim().toLowerCase();
  const groups2 = q
    ? groups.map((g) => ({ ...g, rows: (g.rows || []).filter((r) => String(r.title || '').toLowerCase().includes(q)) })).filter((g) => g.rows.length)
    : groups;
  if (q && !groups2.length) return '<div class="conv-empty" style="padding:14px;color:var(--faint);font-size:13px">No conversations match.</div>';
  // Alpha sort flattens the date groups into a single A–Z list; Recent keeps groups.
  const sorted = s.convSort === 'alpha'
    ? [{ label: 'A–Z', rows: groups2.flatMap((g) => g.rows || []).slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' })) }]
    : groups2;
  const convRow = (r) => `<div class="conv-row${r.active ? ' active' : ' ocrow'}" data-act="selectSession" data-arg="${esc(r.id)}"><span class="conv-badge${r.term ? ' term' : ''}">${r.term ? '∿' : 'A\\'}</span><span class="conv-title">${esc(r.title)}</span><span class="conv-arch" data-act="archiveSession" data-arg="${esc(r.id)}" title="Archive conversation" style="margin-left:auto;padding:0 4px;color:var(--faint);opacity:.5;cursor:pointer">archive</span><span class="conv-del" data-act="deleteSession" data-arg="${esc(r.id)}" title="Delete conversation" style="padding:0 4px;color:var(--faint);opacity:.5;cursor:pointer">✕</span></div>`;
  return map(sorted, (g, gi) => `
    <div class="conv-group${gi === 0 ? ' top' : ''}"><span class="sect-label">${esc(g.label)}</span></div>
    ${map(g.rows, convRow)}`);
}

// one chat message → html (assistant prose / user bubble). Live thread items:
// { role:'assistant'|'user', time, model, text, activity? }
function chatMsg(m, s) {
  const hasText = String(m.text || '').trim().length > 0;
  const paras = hasText
    ? String(m.text).split(/\n\n+/).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
    : '';
  if (m.role === 'user') {
    return `<div class="msg-user-wrap"><div class="msg-user"><div class="meta"><span class="time">${esc(m.time || '')}</span><span class="you">You</span></div>${paras || '<p></p>'}</div></div>`;
  }
  // Empty/failed turn safeguard: when a turn produced no text and no tool work
  // (e.g. the model isn't served on this plan, or the request errored), show an
  // explicit notice instead of a silent blank bubble. See live/chat.js onEvent.
  const notice = m.error
    ? `<div class="msg-error" style="margin-top:6px;display:flex;gap:7px;align-items:flex-start;color:var(--red,#e5616a);font-size:13px;line-height:1.45;background:rgba(229,97,106,.08);border:1px solid rgba(229,97,106,.28);border-radius:8px;padding:8px 11px"><span aria-hidden="true">⚠</span><span>${esc(m.notice || 'No response from this model.')}</span></div>`
    : '';
  return `<div class="msg-asst"><div class="msg-av"><img src="${AVATAR}" alt="Gary"></div><div class="msg-body"><div class="msg-meta"><span class="name">Gary</span>${m.model ? `<span class="model">${esc(m.model)}</span>` : ''}<span class="time">${esc(m.time || '')}</span></div>${renderActivity(m, s)}${paras}${notice}</div></div>`;
}


function chatSurface(s) {
  const d = s.draft || '';
  const typedSlash = d.startsWith('/');
  const open = typedSlash || s.forceSlash;
  const q = typedSlash ? d.slice(1).toLowerCase().split(' ')[0] : '';
  const filtered = SLASH_COMMANDS.filter((c) => q === '' || c.name.slice(1).startsWith(q));
  const slashOpen = open && filtered.length > 0;
  const agent = s.chatMode === 'agent';
  const chat = s.live?.chat || {};
  const title = chat.title ?? 'Workspace Streaming Chat Updates';
  const subtitle = chat.subtitle ?? '12 messages · claude-opus-4';
  const model = chat.model ?? 'opus-4';
  const pct = chat.usagePct != null ? chat.usagePct : 4.4;
  const thread = map(chat.thread || MOCK_CHAT_THREAD, (msg) => chatMsg(msg, s));

  return `
  <div class="chat-head">
    <div style="min-width:0;flex:1">
      <div class="ttl">${esc(title)}</div>
      <div class="sub">${esc(subtitle)}</div>
    </div>
    <div style="position:relative">
      <button class="icon-btn ocbtn" data-act="toggleChatMenu" title="Conversation actions" style="background:none;border:none;color:var(--faint);cursor:pointer;font-size:18px;line-height:1;padding:4px 8px">⋯</button>
      ${when(s.chatMenuOpen, `
      <div class="chat-more-menu" style="position:absolute;right:0;top:30px;z-index:40;background:var(--panel,#1e2025);border:1px solid var(--border);border-radius:10px;padding:5px;min-width:170px;box-shadow:0 10px 34px rgba(0,0,0,.45)">
        <div class="cm-item" data-act="renameSession" style="padding:8px 10px;border-radius:7px;cursor:pointer">Rename</div>
        <div class="cm-item" data-act="copyTranscript" style="padding:8px 10px;border-radius:7px;cursor:pointer">Copy transcript</div>
        <div class="cm-item" data-act="exportChat" style="padding:8px 10px;border-radius:7px;cursor:pointer">Export as Markdown</div>
      </div>`)}
    </div>
  </div>
  <div class="chat-thread">${thread}</div>
  <div class="composer-wrap">
    <button class="scroll-btm ocbtn" data-act="scrollChatBottom" title="Jump to latest" style="position:absolute;right:16px;top:-44px;z-index:25;width:34px;height:34px;border-radius:50%;background:var(--panel,#1e2025);border:1px solid var(--border);color:var(--fg);cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.45)">↓</button>
    ${when(slashOpen, `
    <div class="slash-menu">
      <div class="hd">COMMANDS</div>
      ${map(filtered, (c) => `<div class="slash-cmd" data-act="pickSlash" data-arg="${esc(c.name)}"><span class="glyph" style="color:${c.color}">${c.glyph}</span><span class="name">${esc(c.name)}</span><span class="desc">${esc(c.desc)}</span></div>`)}
    </div>`)}
    ${when(s.modelMenuOpen, `
    <div class="slash-menu model-menu">
      <div class="hd">MODEL <span style="float:right;font-weight:400;text-transform:none;color:var(--faint)">★ = default for new chats</span></div>
      ${(s.live && s.live.modelList && s.live.modelList.length)
        ? map(s.live.modelList, (m) => `<div class="slash-cmd" data-act="setModel" data-arg="${esc(m.mid)}"><span class="name">${esc(m.name)}</span><span class="desc">${esc(m.ep || '')}</span>${m.mid === model ? '<span class="glyph" style="color:var(--green)">✓</span>' : ''}<span data-act="setDefaultModel" data-arg="${esc(m.mid)}" title="Set as default for new chats" style="cursor:pointer;padding:0 4px;color:${m.mid === (s.live && s.live.defaultModel) ? 'var(--gold,#e8c268)' : 'var(--faint)'}">★</span></div>`)
        : '<div class="slash-cmd"><span class="desc">Loading…</span></div>'}
    </div>`)}
    <div class="composer${slashOpen ? ' slash' : ''}">
      <textarea data-model="draft" data-focus="draft" rows="1" placeholder="Message Gary…   ( type / for commands )">${esc(d)}</textarea>
      ${when(s.pendingAttach && s.pendingAttach.length, `
      <div class="attach-pending" style="display:flex;flex-wrap:wrap;gap:6px;padding:4px 6px 0">
        ${map(s.pendingAttach || [], (a) => `<span class="attach-chip" style="display:inline-flex;align-items:center;gap:5px;background:#2a2d33;border-radius:7px;padding:3px 8px;font-size:12px"><span>${esc(a.name || a.id)}</span><span data-act="removeAttach" data-arg="${esc(a.id)}" style="cursor:pointer;color:var(--faint)">✕</span></span>`)}
      </div>`)}
      <div class="composer-row">
        <button class="icon-btn ocbtn" data-act="toggleSlash" title="More tools">${I.plus()}</button>
        <label class="icon-btn ocbtn" title="Attach files" style="cursor:pointer;display:inline-flex;align-items:center"><input type="file" data-upload multiple style="display:none"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></label>
        <div class="ctx-meter" title="Context used"><div class="track"><div class="fill" style="width:${pct}%"></div></div><span class="pct">${pct}%</span></div>
        <div class="oc-spacer"></div>
        <button class="icon-btn ocbtn" data-act="toggleIncognito" title="${s.incognito ? 'Incognito ON — this chat is not saved' : 'Incognito — don’t save this chat'}" style="${s.incognito ? 'color:var(--violet)' : ''}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7"/><path d="M2 12s3 7 10 7 10-7 10-7"/><circle cx="12" cy="12" r="2.5"/>${s.incognito ? '<line x1="3" y1="3" x2="21" y2="21"/>' : ''}</svg></button>
        <button class="model-btn ocbtn" data-act="toggleModelMenu" title="Switch model"><span class="glyph">A\\</span>${esc(model)}${I.chevDownSm()}</button>
        <div class="mode-toggle">
          <button class="${agent ? 'active-agent' : ''}" data-act="setMode" data-arg="agent">Agent</button>
          <button class="${!agent ? 'active-chat' : ''}" data-act="setMode" data-arg="chat">Chat</button>
        </div>
        <button class="btn-send ocbtn" data-act="send" title="Send">${I.send()}</button>
      </div>
    </div>
  </div>`;
}

// ===========================================================================
// EMAIL
// ===========================================================================
function emailSurface(s) {
  const emails = s.live?.email?.emails ?? EMAILS;
  const sel = Math.max(0, Math.min(s.selEmail, emails.length - 1));
  const m = s.live?.email?.current ?? emails[sel] ?? EMAILS[0];
  const attach = m.attach || [];
  const replyTo = (m.from || '').split(' ')[0];
  return `
  <div class="split-h">
    <div class="oc-secondary email-list">
      <div class="list-top">
        <div class="list-top-head"><span class="ttl">Email</span><span class="pill-teal">1 unread</span><div class="oc-spacer"></div><button class="btn btn-teal" data-act="composeNew">+ New</button></div>
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
      </div>
    </div>
    <div class="reader">
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
          ${when(attach.length > 0, `<div class="attach-row">${map(attach, (att) => `<div class="attach ocbtn"><span class="ico">${I.file(15, 'currentColor')}</span><div><div class="nm">${esc(att.name)}</div><div class="sz">${esc(att.size)}</div></div></div>`)}</div>`)}
          <div class="quote"><div class="hd">On Wed, Jun 17, 2026 at 2:16 PM, Frank Emanuele <span class="mono">&lt;femanuele@wistia.com&gt;</span> wrote:</div><p>Hi Mica, Thank you! Here is the signed agreement. Looking forward to working together! — Frank</p></div>
        </div>
      </div>
      <div class="reply-bar">
        <div class="box" data-act="composeReply" data-arg="reply" style="cursor:text">
          <span class="ph">Reply to ${esc(replyTo)}…</span>
          <button class="btn-sm" title="AI draft" data-act="composeAiDraft">✦ Draft</button>
          <button class="btn-send-sm ocbtn" title="Reply" data-act="composeReply" data-arg="reply">${I.send(15)}</button>
        </div>
      </div>
    </div>
  </div>
  ${when(s.composeOpen, composeOverlay(s))}`;
}

// Email compose/reply overlay — bound inputs (composeTo/Subject/Body), Send via
// /api/email/send. Rendered when state.composeOpen.
function composeOverlay(s) {
  const busy = !!s.emailBusy;
  return `
  <div class="oc-compose-scrim" data-act="closeCompose" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:60"></div>
  <div class="oc-compose" style="position:fixed;z-index:61;left:50%;top:50%;transform:translate(-50%,-50%);width:min(640px,92vw);max-height:86vh;display:flex;flex-direction:column;background:var(--panel,#1e2025);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden">
    <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border)">
      <b style="flex:1">New message</b>
      <button class="btn btn-ghost" data-act="composeAiDraft"${busy ? ' disabled' : ''}>✦ AI draft</button>
      <span data-act="closeCompose" style="cursor:pointer;color:var(--faint);padding:0 4px">✕</span>
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
// INBOX
// ===========================================================================
function inboxSurface(s) {
  const items = s.live?.inbox?.items ?? INBOX;
  const visible = items.filter((m) => !s.dismissed.includes(m.id));
  const needs = visible.filter((m) => m.group === 'needs');
  const fyi = visible.filter((m) => m.group === 'fyi');
  const cnt = (src) => visible.filter((m) => m.src === src).length;

  const needsCard = (it) => `
    <div class="inbox-card">
      <div class="top"><span class="src-tag" style="color:${it.srcColor};background:${it.srcBg}">${esc(it.src)}</span><span class="who">${esc(it.who)}</span><span class="ago">· ${esc(it.time)}</span><span class="inbox-x" data-act="dismiss" data-arg="${it.id}">${I.x()}</span></div>
      <div class="body">${esc(it.body)}</div>
      <div class="card-actions"><button class="btn-sm" data-act="dismiss" data-arg="${it.id}">${esc(it.primary)}</button><button class="btn-sm ghost" data-act="dismiss" data-arg="${it.id}">${esc(it.secondary)}</button></div>
    </div>`;
  const fyiCard = (it) => `
    <div class="inbox-card fyi">
      <div class="top"><span class="src-tag" style="color:${it.srcColor};background:${it.srcBg}">${esc(it.src)}</span><span class="who">${esc(it.who)}</span><span class="ago">· ${esc(it.time)}</span><span class="inbox-x" data-act="dismiss" data-arg="${it.id}">${I.x()}</span></div>
      <div class="body">${esc(it.body)}</div>
      <div class="ai-pill">✦ ${esc(it.suggest)}</div>
      <div class="card-actions"><button class="btn-sm" data-act="dismiss" data-arg="${it.id}">Archive</button><button class="btn-sm ghost" data-act="dismiss" data-arg="${it.id}">Keep</button></div>
    </div>`;

  return `
  <div class="inbox-col">
    <div class="inbox-head">
      <div class="row1">
        <span class="ttl">Inbox</span><span class="cnt">${visible.length} to triage</span>
        <div class="oc-spacer"></div>
        <button class="triage-btn" data-act="triageAll">✦ Triage with Gary</button>
      </div>
      <div class="src-chips">
        <span class="src-chip active">All ${visible.length}</span>
        <span class="src-chip"><span class="dot" style="background:var(--red)"></span>gmail ${cnt('GMAIL')}</span>
        <span class="src-chip"><span class="dot" style="background:var(--green)"></span>slack ${cnt('SLACK')}</span>
        <span class="src-chip"><span class="dot" style="background:var(--gold)"></span>asana ${cnt('ASANA')}</span>
      </div>
    </div>
    <div class="inbox-scroll">
      ${when(needs.length > 0, `<div class="grp-label"><span class="lbl needs">NEEDS YOU</span><span class="n">${needs.length}</span><div class="sect-divider"></div></div>${map(needs, needsCard)}`)}
      ${when(fyi.length > 0, `<div class="grp-label fyi"><span class="lbl fyilbl">AI-SUGGESTED · FYI</span><span class="n">${fyi.length}</span><div class="sect-divider"></div></div>${map(fyi, fyiCard)}`)}
      ${when(visible.length === 0, `<div class="inbox-zero"><div class="ico">${I.check()}</div><div class="t">Inbox zero</div><div class="d">Gary cleared the feed. Nothing left to triage.</div></div>`)}
    </div>
  </div>`;
}

// ===========================================================================
// CALENDAR
// ===========================================================================
function calendarSurface(s) {
  const q = (s.quick || '').trim();
  const has = q.length > 0;
  const cell = (c) => {
    const cls = ['cal-cell'];
    if (c.last) cls.push('last');
    if (c.today) cls.push('today');
    const dateHtml = c.today
      ? `<div><span class="cal-today-num">${c.date}</span></div>`
      : `<div class="cal-date${c.dim ? ' dim' : ''}">${c.date}</div>`;
    const bars = (c.bars || []).map((b) => {
      const t = CAL_BAR_TONE[b.tone];
      return `<div class="bar" style="background:${t.bg};color:${t.color}">${b.label ? esc(b.label) : '&nbsp;'}</div>`;
    }).join('');
    const events = (c.events || []).map((e) =>
      `<div class="ev"${e.faded ? ' style="opacity:.5"' : ''}><span class="evdot" style="background:${e.dot}"></span>${esc(e.label)}</div>`).join('');
    const more = c.more ? `<div class="cal-more">${esc(c.more)}</div>` : '';
    return `<div class="${cls.join(' ')}">${dateHtml}${bars}${events}${more}</div>`;
  };
  const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const cells = s.live?.calendar?.cells ?? CAL_CELLS;
  const month = s.live?.calendar?.month ?? CAL_MONTH;
  return `
  <div class="cal-col">
    <div class="cal-top">
      <div class="cal-toolbar">
        <button class="cal-nav">‹</button>
        <button class="btn btn-ghost">Today</button>
        <button class="cal-nav">›</button>
        <span class="cal-month">${esc(month)}</span>
        <div class="oc-spacer"></div>
        <div class="cal-views"><span>Week</span><span class="active">Month</span><span>Agenda</span></div>
        <button class="btn btn-teal" data-act="newEvent">+ New</button>
      </div>
      <div class="cal-quick${has ? ' has' : ''}">
        <span class="star">✦</span>
        <input data-model="quick" data-focus="quick" placeholder="Quick add — try “lunch with Sam tue 1pm” or “return home to Ithaca 1pm tmrw”" value="${esc(s.quick || '')}"/>
        ${when(has, '<button class="cal-add" data-act="clearQuick">↵ Add</button>')}
      </div>
      ${when(has, `<div class="cal-parse"><span class="k">Gary parsed:</span><span class="ev"><span class="d"></span>${esc(q)}</span><span class="x">· Personal · 1 hr</span></div>`)}
    </div>
    <div class="cal-weekdays">${map(weekdays, (d) => `<div>${d}</div>`)}</div>
    <div class="cal-grid">${map(cells, cell)}</div>
  </div>`;
}

// ===========================================================================
// RESEARCH
// ===========================================================================
function researchSurface(s) {
  const has = (s.researchQuery || '').trim().length > 0;
  const running = s.research === 'running';
  const done = s.research === 'done';

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

  const scopes = RESEARCH_SCOPES.map((sc, i) =>
    `<span class="scope-chip${i === 0 ? ' active' : ''}">${esc(sc)}</span>`).join('');

  return `
  <div class="oc-head">${I.research(17, 'var(--teal)')}<span class="title">Deep Research</span><span class="desc">multi-step web research, LLM in the loop</span></div>
  <div class="res-wrap">
    <div class="res-inner">
      <div class="res-composer${has ? ' has' : ''}">
        <textarea data-model="researchQuery" data-focus="researchQuery" rows="2" placeholder="What should Gary investigate? e.g. “Compare the top 3 podcast hosting platforms on price, analytics, and Wistia integration.”">${esc(s.researchQuery || '')}</textarea>
        <div class="scope-chips">${scopes}</div>
        <div class="res-controls">
          <span class="lbl">Defaults — click any to override:</span>
          ${ctlPills}
          <div class="oc-spacer"></div>
          <button class="btn btn-ghost" data-act="startResearch">+ Queue</button>
          <button class="res-start" data-act="startResearch">${I.play()}Start</button>
        </div>
      </div>

      ${when(running, `
      <div class="res-card running">
        <div class="row1"><span class="res-spin"></span><span class="running-ttl">${esc(s.researchProgress?.label || 'Researching…')}</span><div class="oc-spacer"></div><button class="btn btn-ghost" style="height:28px" data-act="resetResearch">Stop</button></div>
        <div class="res-steps">
          <div class="res-step"><span style="color:var(--green)">✓</span><div class="done-txt">Planned the search — 4 sub-questions</div></div>
          <div class="res-step"><span style="color:var(--green)">✓</span><div class="done-txt">Searched the web — <span class="mono" style="color:var(--faint)">12 results</span> across 4 queries</div></div>
          <div class="res-step"><span style="color:var(--teal)">◐</span><div><div class="cur-txt">Reading &amp; cross-checking sources <span class="mono" style="color:var(--faint)">[3 / 8]</span></div><div class="domains">→ buzzsprout.com · transistor.fm · captivate.fm</div></div></div>
          <div class="res-step muted"><span style="color:var(--faint)">○</span><div class="pend-txt">Synthesize findings &amp; build report</div></div>
        </div>
      </div>`)}

      ${when(done, `
      <div class="res-card done">
        <div class="row1"><span class="res-done-ico">✓</span><span class="t">Report ready</span><span class="meta">3 rounds · 8 sources · 2:14</span><div class="oc-spacer"></div><button class="btn btn-ghost" style="height:30px" data-act="resetResearch">New research</button></div>
        <p class="res-summary">${s.live?.research?.summary ?? '<strong>Transistor</strong> wins on price-per-show and unlimited podcasts; <strong>Buzzsprout</strong> leads on ease + analytics polish; <strong>Captivate</strong> is strongest for growth/marketing tools. None has a first-party Wistia integration — all support it via RSS + embed.'}</p>
        <div class="card-actions"><button class="btn-sm" data-act="resReport" data-arg="${esc(s.live?.research?.lastRid || '')}">↗ Visual Report</button><button class="btn-sm ghost" data-act="resDiscuss" data-arg="${esc(s.live?.research?.lastRid || '')}">Discuss in chat</button><button class="btn-sm ghost" data-act="go" data-arg="library">Save to Library</button></div>
      </div>`)}

      <div class="grp-label" style="margin:18px 0 12px"><span class="sect-label">PAST RESEARCH</span><span class="n" style="font-size:11px;color:var(--faint)">${(s.live?.research?.past ?? PAST_RESEARCH).length}</span><div class="sect-divider"></div><span style="font-size:11.5px;color:var(--teal);cursor:pointer">Library, Research →</span></div>
      ${map(s.live?.research?.past ?? PAST_RESEARCH, (r) => `<div class="past-row"><div class="top"><span class="q">${esc(r.q)}</span><span class="m">${esc(r.m)}</span></div><div class="chips"><span class="chip-teal"${r.rid ? ` data-act="resDiscuss" data-arg="${esc(r.rid)}"` : ''}>Discuss</span><span class="chip-ghost"${r.rid ? ` data-act="resReport" data-arg="${esc(r.rid)}"` : ''}>↗ Visual Report</span></div></div>`)}
    </div>
  </div>`;
}

// ===========================================================================
// LIBRARY
// ===========================================================================
function librarySurface(s) {
  const lf = s.libFilter;
  const all = s.live?.library?.items ?? LIBRARY;
  const lq = (s.libQuery || '').trim().toLowerCase();
  const items = all.filter((a) => (lf === 'all' || a.cat === lf) && (!lq || String(a.title || '').toLowerCase().includes(lq)));
  return `
  <div class="oc-head">${I.library(17, 'var(--teal)')}<span class="title">Library</span><span class="desc">artifacts Gary has produced</span><div class="oc-spacer"></div><button class="btn btn-teal" data-act="newDoc" style="margin-right:8px">+ New doc</button><div class="oc-search" style="height:32px;border-radius:8px">${I.search(13, 'currentColor')}<input data-model="libQuery" data-focus="libQuery" placeholder="Filter library…" value="${esc(s.libQuery || '')}" autocomplete="off" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg);font-family:inherit"></div></div>
  <div class="lib-wrap">
    <div class="lib-filters">
      ${map(LIB_FILTERS, ([id, label]) => `<span class="lib-filter${lf === id ? ' active' : ''}" data-act="libFilter" data-arg="${id}">${esc(label)}</span>`)}
    </div>
    <div class="lib-grid">
      ${map(items, (a) => {
        const k = KIND_STYLE[a.kind];
        const openable = a.id && (a.cat === 'doc' || a.cat === 'code');
        return `<div class="lib-card"${openable ? ` data-act="openDoc" data-arg="${esc(a.id)}" style="cursor:pointer"` : ''}>
          <div class="lib-thumb" style="background:${k.thumbBg}"><span class="kl" style="color:${k.kindColor}">${esc(a.kindLabel)}</span></div>
          <div class="meta">
            <div class="t">${esc(a.title)}</div>
            <div class="tags"><span class="lib-tag" style="color:${k.kindColor};background:${k.tagBg}">${esc(a.kind)}</span><span class="when">${esc(a.when)}</span></div>
          </div>
        </div>`;
      })}
    </div>
  </div>`;
}

// ===========================================================================
// NOTES
// ===========================================================================
function notesSurface(s) {
  const docs0 = s.live?.notes?.docs ?? NOTES;
  const sel = Math.max(0, Math.min(s.selDoc, docs0.length - 1));
  const doc = docs0[sel] || NOTES[0];
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
        <div class="list-top-head"><span class="ttl">Notes</span><span style="font-size:11px;color:var(--faint)">vault · 41</span><div class="oc-spacer"></div><button class="btn btn-teal" data-act="newNote">+ New</button></div>
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
      <div class="note-ehead"><span class="path">${esc(doc.path)}</span><div class="oc-spacer"></div><span class="note-saved"><span class="d"></span>saved · v${doc.version}</span><span class="note-hist">History</span></div>
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
        return `<div class="set-buttons">${map(r.buttons, (b) => `<button class="set-btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}"${b.act ? ` data-act="${b.act}"${b.arg != null ? ` data-arg="${esc(String(b.arg))}"` : ''}` : ''}>${esc(b.label)}</button>`)}</div>`;
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
      case 'danger':
        return `<div class="set-danger"><div style="flex:1"><div class="lbl">${esc(r.label)}</div><div class="dsc">${esc(r.desc)}</div></div><button class="set-btn danger" style="height:30px"${r.kind ? ` data-act="wipe" data-arg="${esc(r.kind)}"` : ''}>Wipe</button></div>`;
      case 'text':
        return `<div class="set-text">${esc(r.text)}</div>`;
      case 'accent':
        return `<div class="set-accents">${map(['#4fe3d1', '#7bb6ff', '#5bd97f', '#a99bf5'], (hex) => {
          const on = accent === hex;
          return `<div class="set-accent" data-act="setAccent" data-arg="${hex}" style="background:${hex};box-shadow:0 0 0 ${on ? '3px' : '0px'} ${hex}55">${on ? icon('<path d="M20 6 9 17l-5-5"/>', { size: 17, sw: 3, stroke: '#0c1413' }) : ''}</div>`;
        })}</div>`;
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
