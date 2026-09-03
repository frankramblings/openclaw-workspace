// frontend-overrides/js/__tests__/project-menu.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { moveArg, parseMoveArg, moveMenuItems, projectName, parentTitle, moveMenuHtml, MOVE_NEW, MOVE_NONE } from '../redesign/project-menu.js';

const projects = [
  { id: 'p-b', name: 'Plex' }, { id: 'p-a', name: 'Local AI' }, { id: 'p-w', name: 'Wedding', archived: true },
];

test('move arg round-trips', () => {
  assert.equal(moveArg('s1', 'p-a'), 's1|p-a');
  assert.equal(moveArg('s1', MOVE_NONE), 's1|');
  assert.deepEqual(parseMoveArg('s1|p-a'), { id: 's1', target: 'p-a' });
  assert.deepEqual(parseMoveArg('s1|'), { id: 's1', target: '' });
  assert.deepEqual(parseMoveArg('s1|new'), { id: 's1', target: MOVE_NEW });
  assert.deepEqual(parseMoveArg('garbage'), { id: 'garbage', target: '' });
  assert.deepEqual(parseMoveArg(''), { id: '', target: '' });
});

test('menu items: alphabetical active projects, current marked, none first when filed, new last', () => {
  const items = moveMenuItems('s1', projects, 'p-b');
  assert.deepEqual(items.map((i) => i.label), ['No project', 'Local AI', 'Plex', 'New project…']);
  assert.deepEqual(items.map((i) => i.on), [false, false, true, false]);
  assert.equal(items[1].arg, 's1|p-a');
  assert.equal(items[3].arg, 's1|new');
  const unfiled = moveMenuItems('s1', projects, null);
  assert.deepEqual(unfiled.map((i) => i.label), ['Local AI', 'Plex', 'New project…']);
});

test('projectName and parentTitle', () => {
  assert.equal(projectName(projects, 'p-a'), 'Local AI');
  assert.equal(projectName(projects, 'p-w'), 'Wedding (archived)');
  assert.equal(projectName(projects, 'p-zzz'), '');
  assert.equal(projectName(null, 'p-a'), '');
  const sessions = [{ id: 'par', name: 'Parent thread' }];
  assert.equal(parentTitle(sessions, 'par'), 'Parent thread');
  assert.equal(parentTitle(sessions, 'nope'), null);
  assert.equal(parentTitle(sessions, null), null);
});

test('moveMenuHtml escapes names and carries data-act/data-arg', () => {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = moveMenuHtml('s1', [{ id: 'p-x', name: '<Evil>' }], null, esc);
  assert.ok(html.includes('data-act="moveToProject"'));
  assert.ok(html.includes('data-arg="s1|p-x"'));
  assert.ok(html.includes('&lt;Evil&gt;') && !html.includes('<Evil>'));
  assert.ok(html.includes('New project…'));
});
