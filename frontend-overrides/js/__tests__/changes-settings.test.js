import { test } from 'node:test';
import assert from 'node:assert';
import { changesSettingsHtml } from '../redesign/changes-settings.js';

const model = {
  config: { roots: ['/srv/meetings', '/srv/agent/workspace'], prune_dirs: ['.git', 'tmp'], max_bytes: 262144 },
  stats: { blobs: 120, blob_bytes: 3 * 1024 * 1024, roots: [{ path: '/srv/meetings', files: 40, exists: true, scanned_ms: 1 }, { path: '/srv/agent/workspace', files: 23000, exists: true, scanned_ms: 1 }] },
  draftRoot: '', saving: false, error: null, rebuild: { running: false, root: null },
};

test('lists roots with counts and remove buttons, add form, prune textarea, cache size, rebuild', () => {
  const h = changesSettingsHtml(model);
  assert.ok(h.includes('/srv/meetings') && h.includes('40 files'));
  assert.ok(h.includes('data-act="changesRemoveRoot"') && h.includes('data-arg="/srv/meetings"'));
  assert.ok(h.includes('data-model="changesRootDraft"') && h.includes('data-act="changesAddRoot"'));
  assert.ok(h.includes('data-model="changesPruneDraft"') && h.includes('.git\ntmp'));
  assert.ok(h.includes('3.0 MB') && h.includes('120 cached copies'));
  assert.ok(h.includes('data-act="changesRebuild"') && !h.includes('disabled'));
  assert.ok(!h.includes('—'));
});

test('the add-root input and prune textarea carry data-focus so typing keeps focus', () => {
  const h = changesSettingsHtml(model);
  assert.ok(h.includes('data-model="changesRootDraft" data-focus="changesRootDraft"'));
  assert.ok(h.includes('data-model="changesPruneDraft" data-focus="changesPruneDraft"'));
});

test('both changes drafts are in PLAIN_SHEET_FIELDS so app.js skips the re-render', async () => {
  const fs = await import('node:fs');
  const url = new URL('../redesign/app.js', import.meta.url);
  const src = fs.readFileSync(url, 'utf8');
  const m = src.match(/const PLAIN_SHEET_FIELDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'PLAIN_SHEET_FIELDS not found in app.js');
  assert.ok(m[1].includes("'changesRootDraft'"));
  assert.ok(m[1].includes("'changesPruneDraft'"));
});

test('missing root and running rebuild are shown honestly', () => {
  const m = { ...model, stats: { ...model.stats, roots: [{ path: '/gone', files: 0, exists: false, scanned_ms: 0 }] }, rebuild: { running: true, root: '/x' } };
  const h = changesSettingsHtml(m);
  assert.ok(h.includes('not found on disk'));
  assert.ok(h.includes('Rebuilding /x') && h.includes('disabled'));
});
