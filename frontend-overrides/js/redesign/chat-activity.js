// Chat activity trail (Cowork-style): a collapsible thread of thinking + tool
// steps under each assistant turn, plus a live "Working…" in-progress state.
// Shared by desktop (surfaces.js chatMsg) and mobile (mobile-surfaces.js
// mChatMsg); mobile scales down via CSS under `.m-thread`.
//
// A message carries an optional `activity`:
//   m.activity = {
//     status: 'working' | 'done',
//     worked, elapsed, steps: [ step ]
//   }
//   step = { id, kind:'think'|'read'|'grep'|'edit'|'run'|'web'|'generic',
//            label, file?, meta?, metaColor?, state:'running'|'done'|'error',
//            body?            // thinking text
//            lines?:[{t,c}]   // code/grep/terminal output
//            diff?:[{t,c}]    // unified diff
//            cursor?:bool }   // append a blinking cursor (active run)
// Collapse state lives in s.chatUI: { trail:{[msgId]:bool}, step:{[stepId]:bool} }.

import { icon, fortress } from './icons.js';
import { esc, map, when } from './dom.js';
import { groupSteps, groupLabel, summarize } from './chat-activity-group.js';

// kind → icon path + color
export const ACT_ICONS = {
  think: { color: 'var(--violet)', path: '<path d="M12 2a5 5 0 0 0-5 5c0 1.5.7 2.9 1.8 3.8A4 4 0 0 0 7 14a4 4 0 0 0 4 4h.5"/><path d="M12 2a5 5 0 0 1 5 5c0 1.5-.7 2.9-1.8 3.8A4 4 0 0 1 17 14a4 4 0 0 1-4 4h-.5"/><path d="M12 2v20"/>' },
  read: { color: 'var(--blue)', path: '<path d="M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' },
  grep: { color: 'var(--gold)', path: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>' },
  edit: { color: 'var(--teal)', path: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>' },
  run: { color: 'var(--green)', path: '<path d="m4 17 6-6-6-6M12 19h8"/>' },
  web: { color: 'var(--blue)', path: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>' },
  generic: { color: 'var(--faint)', path: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
};

const chev = (rot) => `<svg class="act-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${rot})"><path d="m9 6 6 6-6 6"/></svg>`;
const checkIcon = (sz = 13) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const STOP_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function codeBlock(lines, cursor) {
  const body = lines.map((ln, i) => {
    const cur = (cursor && i === lines.length - 1) ? '<span class="act-cursor"></span>' : '';
    return `<div class="ln" style="color:${ln.c || '#cfd3da'}">${esc(ln.t)}${cur}</div>`;
  }).join('');
  return `<div class="act-code">${body}</div>`;
}

function stepDetail(st) {
  if (st.kind === 'think' && st.body) {
    return `<div class="act-think">${esc(st.body).replace(/\n/g, '<br>')}</div>`;
  }
  if (st.diff && st.diff.length) return codeBlock(st.diff);
  if (st.lines && st.lines.length) return codeBlock(st.lines, st.cursor);
  return '';
}

// a collapsed step row + (optional) expanded detail. `iconHtml` overrides the
// kind icon (used for the green check on completed steps in the working state).
function stepRow(st, s, { iconHtml, alwaysOpen } = {}) {
  const open = alwaysOpen || !!((s.chatUI && s.chatUI.step) || {})[st.id];
  const ic = ACT_ICONS[st.kind] || ACT_ICONS.generic;
  const left = iconHtml
    ? `<span class="act-ic" style="color:var(--green)">${iconHtml}</span>`
    : `<span class="act-ic" style="color:${ic.color}">${icon(ic.path, { size: 13, sw: 1.8 })}</span>`;
  const detail = stepDetail(st);
  const row = `<div class="act-row ocact"${alwaysOpen ? '' : ` data-act="toggleStep" data-arg="${esc(st.id)}"`}>
    ${left}
    <span class="lbl${st.kind === 'think' ? ' think' : ''}">${esc(st.label)}</span>
    ${st.file ? `<span class="file">${esc(st.file)}</span>` : ''}
    ${st.meta ? `<span class="meta" style="color:${st.metaColor || 'var(--faint)'}">${esc(st.meta)}</span>` : ''}
    <div class="oc-spacer"></div>
    ${detail ? chev(open ? '90deg' : '0deg') : ''}
  </div>`;
  return row + (detail && open ? `<div class="act-detail">${detail}</div>` : '');
}

// active (running) step: gold spinner + shimmer label + live output, always open
function activeStep(st) {
  const out = (st.lines && st.lines.length) ? `<div class="act-detail">${codeBlock(st.lines, true)}</div>` : '';
  return `<div class="act-working">
    <span class="act-spinner gold">${fortress(14)}</span>
    <span class="shimmer act-shim">${esc(st.label || 'Running')}</span>
    ${st.file ? `<span class="file">${esc(st.file)}</span>` : ''}
  </div>${out}`;
}

function summaryText(act) {
  const { parts, failed } = summarize(act.steps);
  const segs = [];
  if (act.elapsed) segs.push(`Worked for ${act.elapsed}`);
  if (parts.length) segs.push(parts.join(', '));
  if (!segs.length) segs.push('Worked');
  let txt = segs.join(' · ');
  if (failed) txt += ` · ${failed} failed`;
  return { txt, failed };
}

// Render one groupSteps item. `working` shows completed singles with a green check.
function renderItem(it, s, working) {
  if (it.type === 'group') {
    const open = !!((s.chatUI && s.chatUI.group) || {})[it.id];
    const failed = it.steps.filter((x) => x.state === 'error').length;
    const ic = ACT_ICONS[it.kind] || ACT_ICONS.generic;
    const meta = failed
      ? `<span class="meta" style="color:var(--red)">${failed} failed</span>` : '';
    const head = `<div class="act-group ocact" data-act="toggleGroup" data-arg="${esc(it.id)}">`
      + `<span class="act-ic" style="color:${ic.color}">${icon(ic.path, { size: 13, sw: 1.8 })}</span>`
      + `<span class="lbl">${esc(groupLabel(it.kind, it.steps.length))}</span>`
      + `<div class="oc-spacer"></div>${meta}${chev(open ? '90deg' : '0deg')}</div>`;
    const body = open
      ? `<div class="act-spine act-subspine">${map(it.steps, (st) => stepRow(st, s))}</div>` : '';
    return head + body;
  }
  const st = it.step;
  if (st.state === 'running') return activeStep(st);
  return working ? stepRow(st, s, { iconHtml: checkIcon(13) }) : stepRow(st, s);
}

function renderWorking(m, s) {
  const act = m.activity;
  const rows = groupSteps(act.steps).map((it) => renderItem(it, s, true)).join('');
  return `
  <div class="act-wrap"><div class="act-spine">
    <div class="act-working">
      <span class="act-spinner">${fortress(14)}</span>
      <span class="shimmer act-shim">${act.resync ? 'Re-syncing…' : 'Working…'}</span>
      ${act.elapsed ? `<span class="act-elapsed">${esc(act.elapsed)}</span>` : ''}
      <div class="oc-spacer"></div>
      <button class="act-stop ocbtn" data-act="stopRun" data-arg="${esc(m.id)}">${STOP_ICON}Stop</button>
    </div>
    ${rows}
  </div></div>`;
}

/** Render the activity trail for a message (returns '' when there's none). */
export function renderActivity(m, s) {
  const act = m.activity;
  if (!act) return '';
  // While working, show the spinner immediately — even before the first step
  // lands — so a turn never sits with no feedback during model warmup.
  if (act.status === 'working') return renderWorking(m, s);
  if (!act.steps || !act.steps.length) return '';

  const trailOpen = !!((s.chatUI && s.chatUI.trail) || {})[m.id]; // default COLLAPSED
  const { txt, failed } = summaryText(act);
  const items = groupSteps(act.steps);
  return `
  <div class="act-wrap">
    <div class="act-summary ocact" data-act="toggleTrail" data-arg="${esc(m.id)}">
      <span style="display:flex;color:${failed ? 'var(--red)' : 'var(--green)'}">${checkIcon(13)}</span>
      <span class="act-worked">${esc(txt)}</span>
      ${chev(trailOpen ? '90deg' : '0deg')}
    </div>
    ${when(trailOpen, `<div class="act-spine">${items.map((it) => renderItem(it, s, false)).join('')}</div>`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Dummy data for the functional mockup (replaced by the live stream in Phase 2)
// ---------------------------------------------------------------------------
export const MOCK_CHAT_THREAD = [
  {
    id: 'm1', role: 'assistant', time: '09:48 PM', model: 'opus-4',
    text: 'On thread switch, call StreamManager.activate(newKey, handleEvent, badge) instead of rebuilding the connection from scratch — it replays missed events first, then reopens the live SSE.\n\nThe activity tree handles tool_call, status and error events.',
    activity: {
      status: 'done', worked: 'Worked for 23s · 5 steps',
      steps: [
        { id: 't1', kind: 'think', label: 'Thought for 6s', state: 'done',
          body: "The thread-switch bug is a reconnect race: rebuilding the SSE drops events fired between teardown and reopen. Better to keep one StreamManager and have it replay the buffered events for the new key before reopening. I'll confirm the activate() signature, then check the call site." },
        { id: 't2', kind: 'read', label: 'Read', file: 'app.js', meta: '172,945 bytes', state: 'done',
          lines: [{ t: 'class StreamManager {', c: '#cfd3da' }, { t: '  activate(key, onEvent, badge) {', c: '#cfd3da' }, { t: '    this.replay(key);   // drains buffered events', c: 'var(--faint)' }, { t: '    this.open(key, onEvent);', c: '#cfd3da' }, { t: '  }', c: '#cfd3da' }] },
        { id: 't3', kind: 'grep', label: 'Searched', file: '"activate("', meta: '3 matches', state: 'done',
          lines: [{ t: 'app.js:2841   sm.activate(newKey, handleEvent, badge)', c: '#cfd3da' }, { t: 'app.js:3902   // TODO rebuild connection on switch', c: 'var(--gold)' }, { t: 'sessions.js:118  this.stream.activate(id, cb)', c: '#cfd3da' }] },
        { id: 't4', kind: 'edit', label: 'Edited', file: 'app.js', meta: '+8 −3', state: 'done',
          diff: [{ t: '- this.stream = new StreamManager(key);', c: 'var(--red)' }, { t: '- this.stream.open(key, handleEvent);', c: 'var(--red)' }, { t: '+ this.stream.activate(key, handleEvent, badge);', c: 'var(--green)' }] },
        { id: 't5', kind: 'run', label: 'Ran', file: 'npm run we-smoke', meta: '✓ 1.2s', metaColor: 'var(--green)', state: 'done',
          lines: [{ t: '✓ activity-tree mounted · 14 events replayed', c: 'var(--green)' }, { t: '✓ SSE reconnect OK · stream live', c: 'var(--green)' }, { t: '✓ 0 dropped events on thread switch', c: 'var(--green)' }] },
      ],
    },
  },
  { id: 'm2', role: 'user', time: '09:50 PM', text: "now have subagent(s) implement all of this and confirm when it's live" },
  {
    id: 'm3', role: 'assistant', time: 'now', model: 'opus-4',
    activity: {
      status: 'working', elapsed: '14s',
      steps: [
        { id: 'w1', kind: 'read', label: 'Read', file: 'StreamManager.js', meta: '142 lines', state: 'done' },
        { id: 'w2', kind: 'edit', label: 'Edited', file: 'app.js', meta: '+8 −3', state: 'done' },
        { id: 'w3', kind: 'run', label: 'Running', file: 'npm run we-smoke', state: 'running', cursor: true,
          lines: [{ t: '✓ activity-tree mounted · 14 events replayed', c: 'var(--green)' }, { t: '✓ SSE reconnect OK · stream live', c: 'var(--green)' }, { t: '› checking dropped events on thread switch', c: 'var(--mut)' }] },
      ],
    },
  },
];
