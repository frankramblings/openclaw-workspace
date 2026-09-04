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

test('existing project rows keep their actions', () => {
  const h = projectsSettingsHtml(base({ projects: [{ id: 'p-1', name: 'A', archived: false }, { id: 'p-2', name: 'B', archived: true }] }));
  assert.match(h, /data-act="renameProject" data-arg="p-1"/);
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
