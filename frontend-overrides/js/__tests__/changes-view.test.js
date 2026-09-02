import { test } from 'node:test';
import assert from 'node:assert';
import { changesSummary, changesCardHtml, diffHtml, changesPaneHtml, attachChangesToThread } from '../redesign/changes-view.js';

const rec = { turn_id: 12, files: [
  { path: 'backend/app.py', kind: 'modified', added: 80, removed: 17, shared: false, reverted: false, diffable: true },
  { path: 'notes/new.md', kind: 'added', added: 2, removed: 0, shared: true, reverted: false, diffable: true },
  { path: 'a.png', kind: 'modified', added: 0, removed: 0, shared: false, reverted: false, diffable: false },
  { path: 'old.txt', kind: 'deleted', added: 0, removed: 4, shared: false, reverted: true, diffable: true },
] };

test('summary', () => {
  assert.equal(changesSummary(rec), 'Changes · 4 files · +82 −21');
  assert.equal(changesSummary({ files: [rec.files[0]] }), 'Changes · 1 file · +80 −17');
  assert.equal(changesSummary({ files: [] }), '');
});

test('card collapsed vs expanded', () => {
  const c = changesCardHtml(rec, { expanded: false });
  assert.ok(c.includes('data-act="changesToggle"') && c.includes('data-arg="12"'));
  assert.ok(!c.includes('backend/app.py'));
  const e = changesCardHtml(rec, { expanded: true });
  assert.ok(e.includes('data-act="changesOpen"') && e.includes('data-arg="12:backend/app.py"'));
  assert.ok(e.includes("may include another chat's work"));
  assert.ok(e.includes('reverted'));
  assert.ok(e.includes('not diffable'));
  assert.ok(!e.includes('—'));
});

test('diffHtml classes and escaping', () => {
  const h = diffHtml('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx <b>\n-old\n+new\n');
  assert.ok(h.includes('class="ln meta"') && h.includes('class="ln hunk"'));
  assert.ok(h.includes('class="ln del">-old') && h.includes('class="ln add">+new'));
  assert.ok(h.includes('&lt;b&gt;') && !h.includes('<b>'));
});

test('pane with an open diff and revert button states', () => {
  const open = { turn: 12, record: rec, path: 'backend/app.py', diff: { diffable: true, text: '+x\n' } };
  const p = changesPaneHtml({ turns: [{ turn_id: 12, files: 4, added: 82, removed: 21, ended_ms: 5 }], open, loading: false, error: null });
  assert.ok(p.includes('data-act="changesRevert"') && p.includes('data-arg="12:backend/app.py"'));
  assert.ok(!p.includes('disabled'));
  const rv = changesPaneHtml({ turns: [], open: { ...open, path: 'old.txt', diff: { diffable: true, text: '-a\n' } }, loading: false, error: null });
  assert.ok(rv.includes('disabled'));
  const err = changesPaneHtml({ turns: [], open: null, loading: false, error: 'network' });
  assert.ok(err.includes('Changes could not be loaded'));
});

test('attachChangesToThread picks last message in window', () => {
  const thread = [
    { id: 'a1', role: 'assistant', _ts: 100 },
    { id: 'a2', role: 'assistant', _ts: 200 },
    { id: 'a3', role: 'assistant', _ts: 300 },
  ];
  const turns = [
    { turn_id: 1, started_ms: 50, ended_ms: 350 },
  ];
  const m = attachChangesToThread(thread, turns);
  assert.equal(m.size, 1);
  assert.equal(m.get('a3').turn_id, 1);
});

test('attachChangesToThread later turn wins contested message', () => {
  const thread = [
    { id: 'a1', role: 'assistant', _ts: 500 },
  ];
  const turns = [
    { turn_id: 1, started_ms: 400, ended_ms: 600 },
    { turn_id: 2, started_ms: 400, ended_ms: 600 },
  ];
  const m = attachChangesToThread(thread, turns);
  assert.equal(m.get('a1').turn_id, 2);
});

test('attachChangesToThread skips messages outside window', () => {
  const thread = [
    { id: 'a1', role: 'assistant', _ts: 100 },
    { id: 'a2', role: 'assistant', _ts: 900 },
  ];
  const turns = [
    { turn_id: 1, started_ms: 100000, ended_ms: 101000 },
  ];
  const m = attachChangesToThread(thread, turns);
  assert.equal(m.size, 0);
});

test('diffHtml strips the carriage return from a CRLF diff', () => {
  const h = diffHtml('@@ -1 +1 @@\r\n-old\r\n+new\r\n');
  assert.ok(!h.includes('\r'), 'no carriage returns should survive into the markup');
  assert.ok(h.includes('>-old<') && h.includes('>+new<'));
});
