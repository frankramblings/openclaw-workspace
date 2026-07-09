// Chat Strip — sticky live-activity state above the composer.
//
// Pure reducer + state factory. Rendering lives in a later phase; this module
// only turns SSE tool events into a compact { todos, plan, agents, collapsed }
// shape that the render layer reads.
//
// Tools that contribute state:
//   TodoWrite       → replaces todos.items (Claude Code CLI harness).
//   TaskCreate      → appends one item; task id captured from tool_output.
//   TaskUpdate      → mutates the matched item (status/subject/activeForm).
//   TaskList        → reconciles from output snapshot (optional).
//   ExitPlanMode    → sets plan.markdown until the next user send.
//   Task            → adds a running background-agent row.
//   sessions_spawn  → same as Task.
//
// Backend forwards `input` on tool_start ONLY for these tools
// (backend/bridge.py _STRIP_INPUT_TOOLS), so ev.input.* arrives already scoped.

const STRIP_TOOLS = new Set([
  'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskList',
  'ExitPlanMode',
  'Task', 'sessions_spawn',
]);

// Regex for parsing task ids out of TaskCreate/TaskList/TaskUpdate output text
// (backend returns raw agent-tool result strings like "Task #3 created …").
const TASK_ID_RE = /#(\d+)/;
const TASK_LIST_LINE_RE = /^#(\d+)\s+\[(pending|in_progress|completed|deleted)\]\s+(.*)$/;

// Agent rows linger this long after tool_result before self-clearing.
export const AGENT_LINGER_MS = 5000;

export function initStripState() {
  return {
    todos: null,   // { msgId, items: [{content,status,activeForm}], updatedAt }
    plan: null,    // { msgId, markdown, ts, dismissed }
    agents: {},    // keyed by tool_id → { id, label, kind, startedAt, endedAt?, state, clearAt? }
    collapsed: false,
  };
}

// Apply a single SSE event to the strip. Returns a new strip object when the
// event mutated state, or the same reference when it was a no-op — callers can
// cheaply skip rerender on identity match.
export function stripReducer(strip, ev, now = Date.now()) {
  if (!ev || !strip) return strip;

  if (ev.type === 'tool_start' && STRIP_TOOLS.has(ev.tool)) {
    const input = ev.input || {};
    if (ev.tool === 'TodoWrite' && Array.isArray(input.todos)) {
      return {
        ...strip,
        todos: {
          msgId: ev.msg_id || null,
          items: input.todos.map((t) => ({
            content: t.content || '',
            status: t.status || 'pending',
            activeForm: t.activeForm || '',
          })),
          updatedAt: now,
        },
      };
    }
    if (ev.tool === 'TaskCreate') {
      // No id yet — that arrives in tool_output. Track by tool_id in the
      // meantime so TaskUpdate landing before the output finish can still
      // stitch (rare but possible in interleaved streams).
      const tempKey = ev.tool_id != null ? String(ev.tool_id) : `pending-${now}`;
      const items = (strip.todos && strip.todos.items) || [];
      const nextItem = {
        id: null,
        tempKey,
        content: input.subject || input.description || '',
        activeForm: input.activeForm || '',
        status: 'pending',
      };
      return {
        ...strip,
        todos: { msgId: ev.msg_id || null, items: [...items, nextItem], updatedAt: now },
      };
    }
    if (ev.tool === 'TaskUpdate' && input.taskId != null) {
      if (!strip.todos || !strip.todos.items) return strip;
      const wantId = String(input.taskId);
      let mutated = false;
      const items = strip.todos.items.map((it) => {
        if (it.id != null && String(it.id) === wantId) {
          mutated = true;
          const next = { ...it };
          if (input.status) next.status = input.status;
          if (input.subject) next.content = input.subject;
          if (input.activeForm != null) next.activeForm = input.activeForm;
          return next;
        }
        return it;
      });
      if (!mutated) return strip;
      // A `deleted` status hides the row entirely.
      const kept = items.filter((it) => it.status !== 'deleted');
      return { ...strip, todos: { ...strip.todos, items: kept, updatedAt: now } };
    }
    if (ev.tool === 'ExitPlanMode' && typeof input.plan === 'string') {
      return {
        ...strip,
        plan: { msgId: ev.msg_id || null, markdown: input.plan, ts: now, dismissed: false },
      };
    }
    if (ev.tool === 'Task' || ev.tool === 'sessions_spawn') {
      const id = ev.tool_id != null ? String(ev.tool_id) : `agent-${now}`;
      const label = input.description || input.subagent_type || input.taskName || ev.tool;
      return {
        ...strip,
        agents: {
          ...strip.agents,
          [id]: {
            id,
            label,
            kind: ev.tool,
            startedAt: now,
            state: 'running',
          },
        },
      };
    }
    return strip;
  }

  if (ev.type === 'tool_output' && ev.tool_id != null) {
    const id = String(ev.tool_id);
    // TaskCreate: stitch the returned task id back onto the placeholder item.
    if (ev.tool === 'TaskCreate' && strip.todos && strip.todos.items) {
      const m = typeof ev.output === 'string' ? ev.output.match(TASK_ID_RE) : null;
      if (m) {
        const newId = m[1];
        let mutated = false;
        const items = strip.todos.items.map((it) => {
          if (it.id == null && it.tempKey === id) {
            mutated = true;
            return { ...it, id: newId };
          }
          return it;
        });
        if (mutated) return { ...strip, todos: { ...strip.todos, items, updatedAt: now } };
      }
      return strip;
    }
    // TaskList: authoritative snapshot — reconcile items in listed order.
    if (ev.tool === 'TaskList' && typeof ev.output === 'string') {
      const parsed = [];
      for (const line of ev.output.split(/\r?\n/)) {
        const m = line.trim().match(TASK_LIST_LINE_RE);
        if (m) parsed.push({ id: m[1], status: m[2], content: m[3] });
      }
      if (!parsed.length) return strip;
      const prev = (strip.todos && strip.todos.items) || [];
      const items = parsed.map((p) => {
        const existing = prev.find((it) => it.id != null && String(it.id) === p.id);
        return {
          id: p.id,
          tempKey: existing ? existing.tempKey : null,
          content: p.content,
          activeForm: existing ? existing.activeForm : '',
          status: p.status,
        };
      });
      return { ...strip, todos: { msgId: null, items, updatedAt: now } };
    }
    // Background agents: mark done/error and start the linger timer.
    const agent = strip.agents[id];
    if (agent && ev.exit_code != null) {
      const nextState = ev.exit_code === 0 ? 'done' : 'error';
      return {
        ...strip,
        agents: {
          ...strip.agents,
          [id]: { ...agent, state: nextState, endedAt: now, clearAt: now + AGENT_LINGER_MS },
        },
      };
    }
    return strip;
  }

  return strip;
}

// Called on turn boundaries — after ev.type === 'done'. Clears the whole todo
// list; the strip mirrors the CURRENT turn's activity, not a persistent task
// tracker. TaskCreate items whose status hasn't converged to completed by
// turn-end would otherwise pin the strip open forever (a real bug: pending
// items from an earlier turn masking new work in a later one). Plan + agents
// survive: plan clears on next user send, agents on their linger.
export function onTurnDone(strip) {
  if (!strip || !strip.todos) return strip;
  return { ...strip, todos: null };
}

// Called when the user sends a new message — plan preview clears (its window
// of relevance was the current turn), agents keep running.
export function onUserSend(strip) {
  if (!strip) return strip;
  return strip.plan ? { ...strip, plan: null } : strip;
}

// Called when the user switches conversation — everything resets. The strip
// is per-current-chat only (v1 scope).
export function onSessionSwitch() {
  return initStripState();
}

// Drop any agent rows whose clearAt is <= now. Callers invoke this from a
// throttled render loop so linger works without a per-agent setTimeout.
export function sweepAgents(strip, now = Date.now()) {
  if (!strip) return strip;
  const agents = strip.agents;
  let mutated = false;
  const next = {};
  for (const [id, a] of Object.entries(agents)) {
    if (a.clearAt != null && a.clearAt <= now) { mutated = true; continue; }
    next[id] = a;
  }
  return mutated ? { ...strip, agents: next } : strip;
}

// Toggle collapse; persists to localStorage so it survives reload.
export function toggleCollapsed(strip, storage) {
  const next = { ...strip, collapsed: !strip.collapsed };
  try { if (storage) storage.setItem('chatStripCollapsed', next.collapsed ? '1' : '0'); } catch (_) {}
  return next;
}

export function readCollapsed(storage) {
  try { return storage && storage.getItem('chatStripCollapsed') === '1'; } catch (_) { return false; }
}

export function isStripEmpty(strip) {
  if (!strip) return true;
  if (strip.todos) return false;
  if (strip.plan && !strip.plan.dismissed) return false;
  for (const _ in strip.agents) return false;
  return true;
}

// ---- Render ---------------------------------------------------------------
// The strip renders inside `.composer-wrap`, above `.composer`. When the strip
// is empty it renders as an empty string — no chrome cost when idle (mode A).
// `renderMarkdown` is passed in so this module stays testable without pulling
// the markdown pipeline into the reducer tests.

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

const STATUS_ICON = {
  pending: '◯',
  in_progress: '◐',
  completed: '☑',
  cancelled: '✕',
};

// Summary line for the collapsed strip. One pill per active source, in the
// order they became active (todos first if present, then plan, then agents).
function renderSummary(strip, now) {
  const pills = [];
  if (strip.todos && strip.todos.items && strip.todos.items.length) {
    const total = strip.todos.items.length;
    const done = strip.todos.items.filter((t) => t.status === 'completed').length;
    const current = strip.todos.items.find((t) => t.status === 'in_progress');
    const label = current ? escHtml(current.activeForm || current.content || '') : 'Todos';
    pills.push(`<span class="cs-pill cs-pill-todos"><span class="cs-ic">☑</span><span class="cs-count">${done}/${total}</span><span class="cs-lbl">${label}</span></span>`);
  }
  if (strip.plan && !strip.plan.dismissed) {
    pills.push(`<span class="cs-pill cs-pill-plan"><span class="cs-ic">⌂</span><span class="cs-lbl">Plan ready</span></span>`);
  }
  for (const id in strip.agents) {
    const a = strip.agents[id];
    const elapsed = fmtElapsed((a.endedAt || now) - a.startedAt);
    const stateClass = a.state === 'done' ? 'cs-agent-done' : a.state === 'error' ? 'cs-agent-err' : 'cs-agent-run';
    const glyph = a.state === 'done' ? '✓' : a.state === 'error' ? '✕' : '⟳';
    pills.push(`<span class="cs-pill cs-pill-agent ${stateClass}"><span class="cs-ic">${glyph}</span><span class="cs-lbl">${escHtml(a.label || a.kind)}</span><span class="cs-elapsed">${elapsed}</span></span>`);
  }
  return pills.join('');
}

function renderTodosSection(strip) {
  if (!strip.todos || !strip.todos.items || !strip.todos.items.length) return '';
  const rows = strip.todos.items.map((t) => {
    const ic = STATUS_ICON[t.status] || '◯';
    const cls = `cs-todo cs-todo-${t.status || 'pending'}`;
    const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content || '';
    return `<div class="${cls}"><span class="cs-todo-ic">${ic}</span><span class="cs-todo-text">${escHtml(label)}</span></div>`;
  }).join('');
  return `<div class="cs-sec cs-sec-todos"><div class="cs-sec-hd">Tasks</div>${rows}</div>`;
}

function renderPlanSection(strip, renderMarkdown) {
  if (!strip.plan || strip.plan.dismissed) return '';
  const md = renderMarkdown ? renderMarkdown(strip.plan.markdown || '') : `<pre>${escHtml(strip.plan.markdown || '')}</pre>`;
  return `<div class="cs-sec cs-sec-plan">
    <div class="cs-sec-hd">Plan preview <button class="cs-plan-dismiss ocbtn" data-act="dismissStripPlan" title="Dismiss">✕</button></div>
    <div class="cs-plan-body">${md}</div>
  </div>`;
}

function renderAgentsSection(strip, now) {
  const ids = Object.keys(strip.agents);
  if (!ids.length) return '';
  const rows = ids.map((id) => {
    const a = strip.agents[id];
    const elapsed = fmtElapsed((a.endedAt || now) - a.startedAt);
    const stateClass = a.state === 'done' ? 'cs-agent-done' : a.state === 'error' ? 'cs-agent-err' : 'cs-agent-run';
    const glyph = a.state === 'done' ? '✓' : a.state === 'error' ? '✕' : '⟳';
    return `<div class="cs-agent ${stateClass}"><span class="cs-agent-ic">${glyph}</span><span class="cs-agent-lbl">${escHtml(a.label || a.kind)}</span><span class="cs-agent-elapsed">${elapsed}</span></div>`;
  }).join('');
  return `<div class="cs-sec cs-sec-agents"><div class="cs-sec-hd">Background</div>${rows}</div>`;
}

// The main render entry point. Returns HTML (or '') for the sticky strip.
// `deps.renderMarkdown(md)` renders the plan-preview markdown; injected so
// tests can stub it out.
export function renderChatStrip(strip, deps = {}, now = Date.now()) {
  if (!strip || isStripEmpty(strip)) return '';
  const collapsed = !!strip.collapsed;
  const summary = renderSummary(strip, now);
  const expanded = collapsed ? '' : `<div class="cs-body">
    ${renderTodosSection(strip)}
    ${renderPlanSection(strip, deps.renderMarkdown)}
    ${renderAgentsSection(strip, now)}
  </div>`;
  const chev = collapsed ? '▸' : '▾';
  return `<div class="chat-strip${collapsed ? ' collapsed' : ''}" data-testid="chat-strip">
    <button class="cs-toggle ocbtn" data-act="toggleChatStrip" title="${collapsed ? 'Expand activity' : 'Collapse activity'}"><span class="cs-chev">${chev}</span></button>
    <div class="cs-summary">${summary}</div>
    ${expanded}
  </div>`;
}
