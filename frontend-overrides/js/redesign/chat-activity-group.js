// Pure helpers for the activity trail. No DOM / browser deps — unit-tested under
// node:test. (1) groupSteps collapses consecutive same-kind COMPLETED steps into
// groups for the expanded view; (2) summarize aggregates a turn for the collapsed
// summary line. Thinking steps and the currently-running step never group.

const GROUP_LABEL = {
  read: (n) => `Read ${n} files`,
  edit: (n) => `Edited ${n} files`,
  grep: (n) => `Searched ${n} times`,
  run: (n) => `Ran ${n} commands`,
  web: (n) => `Searched the web ${n} times`,
  generic: (n) => `Ran ${n} tools`,
};

const PHRASE = {
  read: (n) => `${n} ${n === 1 ? 'file' : 'files'} read`,
  edit: (n) => `${n} ${n === 1 ? 'file' : 'files'} edited`,
  grep: (n) => `${n} ${n === 1 ? 'search' : 'searches'}`,
  run: (n) => `${n} ${n === 1 ? 'command' : 'commands'}`,
  web: (n) => `${n} web ${n === 1 ? 'search' : 'searches'}`,
  generic: (n) => `${n} ${n === 1 ? 'tool' : 'tools'}`,
};

/** Ordered render items: {type:'single',step} | {type:'group',kind,id,steps}. */
export function groupSteps(steps) {
  const items = [];
  let run = null; // { kind, steps:[] }
  const flush = () => {
    if (!run) return;
    if (run.steps.length >= 2) {
      items.push({ type: 'group', kind: run.kind, id: `g-${run.steps[0].id}`, steps: run.steps });
    } else {
      items.push({ type: 'single', step: run.steps[0] });
    }
    run = null;
  };
  for (const st of steps || []) {
    if (st.kind === 'think' || st.state === 'running') {
      flush();
      items.push({ type: 'single', step: st });
      continue;
    }
    if (run && run.kind === st.kind) run.steps.push(st);
    else { flush(); run = { kind: st.kind, steps: [st] }; }
  }
  flush();
  return items;
}

/** Plural, kind-specific group line, e.g. "Ran 11 commands". */
export function groupLabel(kind, count) {
  return (GROUP_LABEL[kind] || GROUP_LABEL.generic)(count);
}

/** { parts:[string], failed:number } for the collapsed summary line. */
export function summarize(steps) {
  const order = [];
  const counts = new Map();
  let failed = 0;
  for (const st of steps || []) {
    if (st.kind === 'think') continue;
    if (!counts.has(st.kind)) order.push(st.kind);
    counts.set(st.kind, (counts.get(st.kind) || 0) + 1);
    if (st.state === 'error') failed += 1;
  }
  const parts = order.map((kind) => (PHRASE[kind] || PHRASE.generic)(counts.get(kind)));
  return { parts, failed };
}
