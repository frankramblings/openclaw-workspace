import { test } from 'node:test';
import assert from 'node:assert';
import { TAB, NAV_GROUPS, PANELS } from '../redesign/settings-data.js';
import { renderCenter } from '../redesign/surfaces.js';

test('settings-data: Projects tab exists in TAB, NAV_GROUPS, and PANELS (spec 6.3)', () => {
  assert.ok(TAB.projects, 'TAB.projects must exist');
  assert.strictEqual(TAB.projects[0], 'Projects');

  const group = NAV_GROUPS.find((g) => Array.isArray(g) && g.includes('appearance'));
  assert.ok(group, 'the appearance/shortcuts nav group must exist');
  assert.ok(group.includes('shortcuts'));
  assert.ok(group.includes('projects'), 'projects must be added to the appearance/shortcuts nav group');

  const rows = PANELS.projects && PANELS.projects[0] && PANELS.projects[0].rows;
  assert.ok(Array.isArray(rows), 'PANELS.projects[0].rows must exist');
  assert.ok(rows.some((r) => r.type === 'projects'), 'a { type: "projects" } row must be present');
  const btnRow = rows.find((r) => r.type === 'buttons');
  assert.ok(btnRow, 'a buttons row must be present');
  assert.ok(btnRow.buttons.some((b) => b.act === 'runProjectBackfill'), 'a Re-run backfill button must be present');
});

test('renderRow projects: lists active then archived projects with the right actions, names escaped', () => {
  const live = {
    projects: [
      { id: 'p-arch', name: 'Archived Proj', archived: true },
      { id: 'p-active', name: '<b>Active</b> Proj', archived: false },
    ],
  };
  const s = { surface: 'settings', setSection: 'projects', ui: {}, accent: '#4fe3d1', live };
  const html = renderCenter(s);

  // Active project row: Rename / Archive / Delete, name escaped.
  assert.match(html, /&lt;b&gt;Active&lt;\/b&gt; Proj/);
  assert.doesNotMatch(html, /<b>Active<\/b>/);
  assert.match(html, /data-act="renameProject" data-arg="p-active"/);
  assert.match(html, /data-act="archiveProject" data-arg="p-active"/);
  assert.match(html, /data-act="deleteProject" data-arg="p-active"/);

  // Archived project: under an "Archived" head, with Unarchive instead of Archive.
  assert.match(html, /Archived</);
  assert.match(html, /data-act="unarchiveProject" data-arg="p-arch"/);
  assert.match(html, /data-act="renameProject" data-arg="p-arch"/);
  assert.match(html, /data-act="deleteProject" data-arg="p-arch"/);

  // Active section must not offer Unarchive, archived section must not offer Archive.
  const activeIdx = html.indexOf('p-active');
  const archIdx = html.indexOf('p-arch');
  assert.ok(activeIdx < archIdx, 'active project must render before the archived one');
});

test('renderRow projects: empty state before load and no-active-projects state', () => {
  const s1 = { surface: 'settings', setSection: 'projects', ui: {}, accent: '#4fe3d1', live: {} };
  const html1 = renderCenter(s1);
  assert.match(html1, /set-live-empty/);

  const s2 = { surface: 'settings', setSection: 'projects', ui: {}, accent: '#4fe3d1', live: { projects: [] } };
  const html2 = renderCenter(s2);
  // Task 6 replaces the old backfill-only empty state with the suggested
  // projects flow's "No projects yet" copy (see projects-settings.js).
  assert.match(html2, /No projects yet/);
});
