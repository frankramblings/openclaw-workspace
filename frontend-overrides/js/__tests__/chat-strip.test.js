import { test } from 'node:test';
import assert from 'node:assert';
import {
  initStripState, stripReducer, onTurnDone, onUserSend, onSessionSwitch,
  sweepAgents, toggleCollapsed, readCollapsed, isStripEmpty, AGENT_LINGER_MS,
  renderChatStrip,
} from '../redesign/chat-strip.js';

const todo = (content, status = 'pending') => ({ content, status, activeForm: content });

test('init is empty', () => {
  const s = initStripState();
  assert.equal(s.todos, null);
  assert.equal(s.plan, null);
  assert.deepEqual(s.agents, {});
  assert.equal(s.collapsed, false);
  assert.ok(isStripEmpty(s));
});

test('TodoWrite tool_start populates todos', () => {
  const s0 = initStripState();
  const s1 = stripReducer(s0, {
    type: 'tool_start', tool: 'TodoWrite', tool_id: 't1',
    input: { todos: [todo('write reducer', 'in_progress'), todo('wire it up')] },
  }, 1000);
  assert.equal(s1.todos.items.length, 2);
  assert.equal(s1.todos.items[0].status, 'in_progress');
  assert.equal(s1.todos.updatedAt, 1000);
  assert.ok(!isStripEmpty(s1));
});

test('consecutive TodoWrite calls UPDATE, do not stack', () => {
  let s = initStripState();
  s = stripReducer(s, {
    type: 'tool_start', tool: 'TodoWrite',
    input: { todos: [todo('a'), todo('b')] },
  }, 1000);
  s = stripReducer(s, {
    type: 'tool_start', tool: 'TodoWrite',
    input: { todos: [todo('a', 'completed'), todo('b', 'in_progress'), todo('c')] },
  }, 2000);
  assert.equal(s.todos.items.length, 3);
  assert.equal(s.todos.items[0].status, 'completed');
  assert.equal(s.todos.items[1].status, 'in_progress');
});

test('ExitPlanMode captures plan markdown', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'ExitPlanMode',
    input: { plan: '## Plan\n- do X\n- do Y' },
  }, 500);
  assert.match(s.plan.markdown, /do X/);
  assert.equal(s.plan.dismissed, false);
  assert.equal(s.plan.ts, 500);
});

test('Task tool_start adds a running agent row', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'Task', tool_id: 'ag-42',
    input: { description: 'Audit repo for shipping gaps', subagent_type: 'Explore' },
  }, 100);
  assert.equal(s.agents['ag-42'].state, 'running');
  assert.equal(s.agents['ag-42'].label, 'Audit repo for shipping gaps');
  assert.equal(s.agents['ag-42'].kind, 'Task');
});

test('sessions_spawn behaves like Task', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'sessions_spawn', tool_id: 'ag-9',
    input: { taskName: 'nightly-build' },
  }, 0);
  assert.equal(s.agents['ag-9'].label, 'nightly-build');
  assert.equal(s.agents['ag-9'].kind, 'sessions_spawn');
});

test('agent tool_output marks state + sets linger clearAt', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'Task', tool_id: 'ag-1',
    input: { description: 'X' },
  }, 1000);
  s = stripReducer(s, { type: 'tool_output', tool_id: 'ag-1', exit_code: 0 }, 5000);
  assert.equal(s.agents['ag-1'].state, 'done');
  assert.equal(s.agents['ag-1'].clearAt, 5000 + AGENT_LINGER_MS);
});

test('agent non-zero exit → error state', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'Task', tool_id: 'ag-1', input: { description: 'X' },
  }, 0);
  s = stripReducer(s, { type: 'tool_output', tool_id: 'ag-1', exit_code: 1 }, 100);
  assert.equal(s.agents['ag-1'].state, 'error');
});

test('sweepAgents drops rows past clearAt', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'Task', tool_id: 'ag-1', input: { description: 'X' },
  }, 0);
  s = stripReducer(s, { type: 'tool_output', tool_id: 'ag-1', exit_code: 0 }, 100);
  const clearAt = s.agents['ag-1'].clearAt;
  const before = sweepAgents(s, clearAt - 1);
  assert.ok(before.agents['ag-1'], 'still present just before clearAt');
  const after = sweepAgents(s, clearAt + 1);
  assert.equal(after.agents['ag-1'], undefined);
});

test('onTurnDone clears TodoWrite items regardless of status', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TodoWrite',
    input: { todos: [todo('a', 'completed'), todo('b', 'in_progress')] },
  });
  assert.equal(onTurnDone(s).todos, null, 'TodoWrite is per-turn; must not pin the strip open');
});

test('onUserSend clears the plan preview only', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'ExitPlanMode', input: { plan: 'do stuff' },
  });
  s = stripReducer(s, {
    type: 'tool_start', tool: 'Task', tool_id: 'ag-1', input: { description: 'x' },
  });
  const after = onUserSend(s);
  assert.equal(after.plan, null);
  assert.ok(after.agents['ag-1'], 'agents survive user send');
});

test('onSessionSwitch resets everything', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'ExitPlanMode', input: { plan: 'p' },
  });
  const reset = onSessionSwitch(s);
  assert.equal(reset.todos, null);
  assert.equal(reset.plan, null);
  assert.deepEqual(reset.agents, {});
});

test('toggleCollapsed flips and persists', () => {
  const store = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  })();
  const s0 = initStripState();
  const s1 = toggleCollapsed(s0, store);
  assert.equal(s1.collapsed, true);
  assert.equal(store.getItem('chatStripCollapsed'), '1');
  assert.equal(readCollapsed(store), true);
  const s2 = toggleCollapsed(s1, store);
  assert.equal(s2.collapsed, false);
  assert.equal(readCollapsed(store), false);
});

test('non-strip tool_start is ignored (identity return)', () => {
  const s0 = initStripState();
  const s1 = stripReducer(s0, {
    type: 'tool_start', tool: 'Bash', input: { command: 'ls' },
  });
  assert.strictEqual(s1, s0);
});

test('tool_output without matching agent is a no-op', () => {
  const s0 = initStripState();
  const s1 = stripReducer(s0, { type: 'tool_output', tool_id: 'unknown', exit_code: 0 });
  assert.strictEqual(s1, s0);
});

test('isStripEmpty is true even with a dismissed plan', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'ExitPlanMode', input: { plan: 'p' },
  });
  s = { ...s, plan: { ...s.plan, dismissed: true } };
  assert.ok(isStripEmpty(s));
});

// ---- render ---------------------------------------------------------------

test('renderChatStrip returns empty string when idle', () => {
  assert.equal(renderChatStrip(initStripState()), '');
  assert.equal(renderChatStrip(null), '');
});

test('renderChatStrip renders todo count + current in-progress label', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TodoWrite',
    input: { todos: [
      { content: 'a', status: 'completed', activeForm: 'Doing a' },
      { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
      { content: 'c', status: 'pending', activeForm: 'Doing c' },
    ] },
  });
  const html = renderChatStrip(s);
  assert.ok(html.includes('chat-strip'));
  assert.ok(html.includes('1/3'));
  assert.ok(html.includes('Doing b'));
  assert.ok(html.includes('cs-todo-in_progress'));
  assert.ok(html.includes('cs-todo-completed'));
});

test('renderChatStrip renders plan preview using injected renderMarkdown', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'ExitPlanMode', input: { plan: '## Plan' },
  });
  const html = renderChatStrip(s, { renderMarkdown: (md) => `<h2>PLAN:${md}</h2>` });
  assert.ok(html.includes('<h2>PLAN:## Plan</h2>'));
  assert.ok(html.includes('dismissStripPlan'));
});

test('renderChatStrip shows agent row with elapsed time', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'Task', tool_id: 'a1',
    input: { description: 'Audit repo' },
  }, 1000);
  const html = renderChatStrip(s, {}, 4000);
  assert.ok(html.includes('Audit repo'));
  assert.ok(html.includes('3s'));
});

test('renderChatStrip collapsed omits body but keeps summary', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TodoWrite',
    input: { todos: [{ content: 'a', status: 'pending' }] },
  });
  s = { ...s, collapsed: true };
  const html = renderChatStrip(s);
  assert.ok(html.includes('collapsed'));
  assert.ok(html.includes('cs-summary'));
  assert.ok(!html.includes('cs-body'));
});

test('renderChatStrip escapes todo content', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TodoWrite',
    input: { todos: [{ content: '<img src=x onerror=alert(1)>', status: 'pending' }] },
  });
  const html = renderChatStrip(s);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

// ---- OpenClaw TaskCreate / TaskUpdate / TaskList paths --------------------

test('TaskCreate tool_start appends a pending placeholder item', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TaskCreate', tool_id: 'tc-1',
    input: { subject: 'Do the thing', activeForm: 'Doing the thing' },
  }, 1000);
  assert.equal(s.todos.items.length, 1);
  assert.equal(s.todos.items[0].id, null);
  assert.equal(s.todos.items[0].tempKey, 'tc-1');
  assert.equal(s.todos.items[0].content, 'Do the thing');
  assert.equal(s.todos.items[0].status, 'pending');
});

test('TaskCreate tool_output stitches the returned task id', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TaskCreate', tool_id: 'tc-1',
    input: { subject: 'A' },
  }, 1000);
  s = stripReducer(s, {
    type: 'tool_output', tool: 'TaskCreate', tool_id: 'tc-1',
    output: 'Task #7 created successfully: A', exit_code: 0,
  }, 1100);
  assert.equal(s.todos.items[0].id, '7');
});

test('TaskUpdate mutates status of item by taskId', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TaskCreate', tool_id: 'tc-1', input: { subject: 'A' },
  }, 1000);
  s = stripReducer(s, {
    type: 'tool_output', tool: 'TaskCreate', tool_id: 'tc-1',
    output: 'Task #3 created successfully: A', exit_code: 0,
  }, 1050);
  s = stripReducer(s, {
    type: 'tool_start', tool: 'TaskUpdate', tool_id: 'tu-1',
    input: { taskId: '3', status: 'in_progress', activeForm: 'Doing A' },
  }, 1100);
  assert.equal(s.todos.items[0].status, 'in_progress');
  assert.equal(s.todos.items[0].activeForm, 'Doing A');
});

test('TaskUpdate with status:deleted removes the item', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TaskCreate', tool_id: 'tc-1', input: { subject: 'A' },
  }, 1000);
  s = stripReducer(s, {
    type: 'tool_output', tool: 'TaskCreate', tool_id: 'tc-1',
    output: 'Task #4 created successfully: A', exit_code: 0,
  }, 1050);
  s = stripReducer(s, {
    type: 'tool_start', tool: 'TaskUpdate', input: { taskId: '4', status: 'deleted' },
  }, 1100);
  assert.equal(s.todos.items.length, 0);
});

test('TaskUpdate before TaskCreate output is a no-op (nothing to match)', () => {
  const s0 = initStripState();
  const s1 = stripReducer(s0, {
    type: 'tool_start', tool: 'TaskUpdate', input: { taskId: '99', status: 'in_progress' },
  }, 1000);
  assert.strictEqual(s0, s1);
});

test('TaskList tool_output reconciles a full snapshot', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_output', tool: 'TaskList', tool_id: 'tl-1',
    output: '#1 [in_progress] First\n#2 [pending] Second\n#3 [completed] Third',
    exit_code: 0,
  }, 1000);
  assert.equal(s.todos.items.length, 3);
  assert.deepEqual(s.todos.items.map((i) => i.id), ['1', '2', '3']);
  assert.equal(s.todos.items[0].status, 'in_progress');
  assert.equal(s.todos.items[2].content, 'Third');
});

test('onTurnDone keeps pending TaskCreate items across turns', () => {
  let s = stripReducer(initStripState(), {
    type: 'tool_start', tool: 'TaskCreate', tool_id: 'tc-1', input: { subject: 'A' },
  }, 1000);
  s = stripReducer(s, {
    type: 'tool_output', tool: 'TaskCreate', tool_id: 'tc-1',
    output: 'Task #1 created successfully: A', exit_code: 0,
  }, 1050);
  // TaskCreate is durable background work — a pending task must survive
  // onTurnDone so its progress remains visible in the next turn.
  const after = onTurnDone(s);
  assert.ok(after.todos, 'todos survives when a TaskCreate item is still pending');
  assert.equal(after.todos.items.length, 1);
  assert.equal(after.todos.items[0].id, '1');
  assert.equal(after.todos.items[0].status, 'pending');
});

test('onTurnDone drops completed TaskCreate items and clears when empty', () => {
  const s = stripReducer(initStripState(), {
    type: 'tool_output', tool: 'TaskList', tool_id: 'tl-1',
    output: '#1 [completed] Done', exit_code: 0,
  }, 1000);
  assert.equal(onTurnDone(s).todos, null, 'completed-only list clears to null');
});
