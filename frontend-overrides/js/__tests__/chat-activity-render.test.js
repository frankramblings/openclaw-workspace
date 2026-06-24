import { test } from 'node:test';
import assert from 'node:assert';
import { renderActivity } from '../redesign/chat-activity.js';

const step = (id, kind, state = 'done', extra = {}) =>
  ({ id, kind, state, label: kind, file: kind + '-target', lines: [], ...extra });
const ui = (over = {}) => ({ chatUI: { trail: {}, step: {}, group: {}, ...over } });

const doneMsg = (steps) => ({ id: 'm1', role: 'assistant', activity: { status: 'done', elapsed: '31s', steps } });

test('done turn is collapsed by default: summary only, no expanded spine', () => {
  const html = renderActivity(doneMsg([step('a', 'run'), step('b', 'run')]), ui());
  assert.match(html, /act-summary/);
  assert.match(html, /Worked for 31s/);
  assert.match(html, /2 commands/);
  assert.doesNotMatch(html, /act-spine/); // not expanded
});

test('expanded done turn shows a group line with toggleGroup and a count label', () => {
  const html = renderActivity(
    doneMsg([step('a', 'run'), step('b', 'run'), step('c', 'run')]),
    ui({ trail: { m1: true } }),
  );
  assert.match(html, /act-spine/);
  assert.match(html, /data-act="toggleGroup"/);
  assert.match(html, /data-arg="g-a"/);
  assert.match(html, /Ran 3 commands/);
});

test('expanding a group reveals its member rows', () => {
  const html = renderActivity(
    doneMsg([step('a', 'run'), step('b', 'run')]),
    ui({ trail: { m1: true }, group: { 'g-a': true } }),
  );
  assert.match(html, /act-subspine/);
  assert.match(html, /data-act="toggleStep" data-arg="a"/);
  assert.match(html, /data-act="toggleStep" data-arg="b"/);
});

test('a lone run renders as a normal row, not a group', () => {
  const html = renderActivity(doneMsg([step('a', 'run')]), ui({ trail: { m1: true } }));
  assert.doesNotMatch(html, /toggleGroup/);
  assert.match(html, /data-act="toggleStep" data-arg="a"/);
});

test('failures bubble to the summary and the group line', () => {
  const steps = [step('a', 'run'), step('b', 'run', 'error')];
  const collapsed = renderActivity(doneMsg(steps), ui());
  assert.match(collapsed, /1 failed/);
  const expanded = renderActivity(doneMsg(steps), ui({ trail: { m1: true } }));
  assert.match(expanded, /1 failed/);
});

const workingMsg = (steps, elapsed = '14s') =>
  ({ id: 'm2', role: 'assistant', activity: { status: 'working', elapsed, steps } });

test('working state groups completed runs and streams the running step standalone', () => {
  const html = renderActivity(workingMsg([
    step('a', 'run'), step('b', 'run'),     // done -> group
    step('c', 'run', 'running'),            // running -> standalone activeStep
  ]), ui());
  assert.match(html, /Working/);            // working header
  assert.match(html, /Stop/);              // stop button
  assert.match(html, /Ran 2 commands/);    // completed run grouped
  assert.match(html, /act-working/);       // running step rendered as active
});

test('working state shows a single completed step with a check, not a group', () => {
  const html = renderActivity(workingMsg([
    step('a', 'read'),
    step('b', 'run', 'running'),
  ]), ui());
  assert.doesNotMatch(html, /toggleGroup/);  // lone read not grouped
  assert.match(html, /data-act="toggleStep" data-arg="a"/);
});

test('working state shows the spinner immediately, before any step lands', () => {
  // Instant send feedback: a working turn with zero steps must still render the
  // "Working…" spinner (model warmup) rather than collapsing to nothing.
  const html = renderActivity(workingMsg([]), ui());
  assert.match(html, /act-working/);
  assert.match(html, /Working/);
  assert.match(html, /Stop/);
});

test('a done turn with no steps renders nothing (pure-text reply)', () => {
  // The immediate working spinner must vanish at turn end when no tools ran,
  // leaving just the assistant's text.
  assert.strictEqual(renderActivity(doneMsg([]), ui()), '');
});
