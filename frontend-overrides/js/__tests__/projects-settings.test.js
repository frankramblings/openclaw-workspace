import test from 'node:test';
import assert from 'node:assert/strict';
import { projectsSettingsHtml, proposalRowHtml } from '../redesign/projects-settings.js';

const base = (over = {}) => ({ live: { projects: [], projectProposals: { proposals: [], error: null, running: false, busy: false }, ...over } });

test('loading state', () => {
  const h = projectsSettingsHtml({ live: {} });
  assert.match(h, /haven.t loaded yet/);
});

test('empty store without proposals offers Find projects', () => {
  const h = projectsSettingsHtml(base());
  assert.match(h, /No projects yet/);
  assert.match(h, /data-act="projectsDiscover"/);
  assert.doesNotMatch(h, /Suggested projects/);
});

test('proposals render with accept and dismiss and samples', () => {
  const h = projectsSettingsHtml(base({ projectProposals: { proposals: [
    { id: 'd-1', name: 'Plex <b>', hints: ['plex'], sample_titles: ['Set up Plex', 'Radarr'], count: 3 },
  ], error: null, running: false, busy: false } }));
  assert.match(h, /Suggested projects/);
  assert.match(h, /Plex &lt;b&gt;/);
  assert.match(h, /3 conversations/);
  assert.match(h, /Set up Plex/);
  assert.match(h, /data-act="projectsAccept" data-arg="d-1"/);
  assert.match(h, /data-act="projectsDismiss" data-arg="d-1"/);
});

test('running and error states', () => {
  assert.match(projectsSettingsHtml(base({ projectProposals: { proposals: [], error: null, running: true, busy: false } })), /Looking for projects/);
  const h = projectsSettingsHtml(base({ projectProposals: { proposals: [], error: 'model_failed', running: false, busy: false } }));
  assert.match(h, /local model did not answer/);
  assert.match(h, /data-act="projectsDiscover"/);
});

test('too_few_threads explains itself and offers no retry button', () => {
  const h = projectsSettingsHtml(base({ projectProposals: { proposals: [], error: 'too_few_threads', running: false, busy: false } }));
  assert.match(h, /Not enough recent conversations/);
  assert.match(h, /12 or more in the last 90 days/);
  assert.doesNotMatch(h, /data-act="projectsDiscover"/);
  assert.doesNotMatch(h, /\u2014/);
});

test('existing project rows keep their actions', () => {
  const h = projectsSettingsHtml(base({ projects: [{ id: 'p-1', name: 'A', archived: false }, { id: 'p-2', name: 'B', archived: true }] }));
  assert.match(h, /data-act="projectEditOpen" data-arg="p-1"/);
  assert.match(h, /data-act="archiveProject" data-arg="p-1"/);
  assert.match(h, /data-act="unarchiveProject" data-arg="p-2"/);
  assert.match(h, /Archived/);
});

test('copy has no em dashes', () => {
  const h = projectsSettingsHtml(base({ projectProposals: { proposals: [{ id: 'd-1', name: 'X', hints: [], sample_titles: [], count: 3 }], error: 'model_failed', running: false, busy: false } }));
  assert.doesNotMatch(h + proposalRowHtml({ id: 'd', name: 'n', hints: [], sample_titles: [], count: 4 }), /\u2014/);
});

test('accept_failed with a proposal still in the list shows the sentence and no Try again button', () => {
  const h = projectsSettingsHtml(base({ projectProposals: { proposals: [
    { id: 'd-1', name: 'Plex', hints: [], sample_titles: [], count: 3 },
  ], error: 'accept_failed', running: false, busy: false } }));
  assert.match(h, /Could not create that project/);
  assert.doesNotMatch(h, /data-act="projectsDiscover"/);
});

test('accept_failed with an empty proposals list shows the sentence and the Try again button', () => {
  const h = projectsSettingsHtml(base({ projectProposals: { proposals: [], error: 'accept_failed', running: false, busy: false } }));
  assert.match(h, /Could not create that project/);
  assert.match(h, /data-act="projectsDiscover"/);
});

test('dismiss_failed shows the sentence and still renders the restored proposal with its actions', () => {
  const h = projectsSettingsHtml(base({ projectProposals: { proposals: [
    { id: 'd-1', name: 'Plex', hints: [], sample_titles: [], count: 3 },
  ], error: 'dismiss_failed', running: false, busy: false } }));
  assert.match(h, /Could not dismiss/);
  assert.match(h, /data-act="projectsAccept" data-arg="d-1"/);
  assert.match(h, /data-act="projectsDismiss" data-arg="d-1"/);
});

const two = [{ id: 'p-1', name: 'A', archived: false }, { id: 'p-2', name: 'B', archived: false }];
const sess = [
  { id: 's1', name: 'Alpha <x>', folder: 'p-1', updated: 3 },
  { id: 's2', name: 'Beta', folder: 'p-1', updated: 2 },
  { id: 's3', name: 'Loose', folder: null, updated: 1 },
  { id: 's4', name: 'Gone', folder: 'p-1', updated: 9, archived: true },
];
const st = (over = {}, live = {}) => ({ ...over, live: { projects: two, projectProposals: { proposals: [], error: null, running: false, busy: false }, chat: { sessions: sess }, ...live } });

test('New button always shows; the new-project panel opens inline with name and hints fields', () => {
  assert.match(projectsSettingsHtml(st()), /data-act="projectEditOpen" data-arg="new"/);
  const h = projectsSettingsHtml(st({ projEditId: 'new', projEditName: 'Fam', projEditHints: 'cece, marissa' }));
  assert.match(h, /data-model="projEditName"[^>]*value="Fam"/);
  assert.match(h, /data-model="projEditHints"[^>]*value="cece, marissa"/);
  assert.match(h, /data-act="projectEditSave">Create/);
});

test('edit panel shows only under the row being edited and surfaces an error line', () => {
  const h = projectsSettingsHtml(st({ projEditId: 'p-2', projEditName: 'B', projEditHints: '', projEditError: 'A project with that name exists.' }));
  assert.equal((h.match(/data-act="projectEditSave"/g) || []).length, 1);
  assert.match(h, /Save<\/button>/);
  assert.match(h, /name exists/);
});

test('merge panel lists other active projects as chips with src>dst args', () => {
  const h = projectsSettingsHtml(st({ projMergeId: 'p-1' }));
  assert.match(h, /data-act="projectMerge" data-arg="p-1&gt;p-2"|data-act="projectMerge" data-arg="p-1>p-2"/);
  assert.doesNotMatch(h, /data-act="projectMerge" data-arg="p-1.p-1"/);
});

test('threads panel lists only that project\'s live threads, newest first, escaped, with selection and targets', () => {
  const h = projectsSettingsHtml(st({ projMoveId: 'p-1' }, { projSel: ['s1'] }));
  assert.match(h, /Alpha &lt;x&gt;/);
  assert.doesNotMatch(h, /Loose|Gone/);
  assert.ok(h.indexOf('Alpha') < h.indexOf('Beta'));
  assert.match(h, /1 selected/);
  assert.match(h, /data-act="projectBulkMove" data-arg="p-2"/);
  assert.match(h, /data-act="projectBulkMove" data-arg="none"/);
});

test('unfiled pseudo-row opens a panel of unfiled threads and offers no Unfiled target', () => {
  const h = projectsSettingsHtml(st({ projMoveId: 'unfiled' }, { projSel: ['s3'] }));
  assert.match(h, /Loose/);
  assert.doesNotMatch(h, /Alpha/);
  assert.doesNotMatch(h, /data-arg="none"/);
});

test('threads filter narrows the list', () => {
  const h = projectsSettingsHtml(st({ projMoveId: 'p-1', projMoveFilter: 'bet' }));
  assert.match(h, /Beta/);
  assert.doesNotMatch(h, /Alpha/);
});
