import { test } from 'node:test';
import assert from 'node:assert';
import { changesSettingsHtml } from '../redesign/changes-settings.js';

const model = {
  config: { roots: ['/home/frank/meetings', '/home/frank/.openclaw/workspace'], prune_dirs: ['.git', 'tmp'], max_bytes: 262144 },
  stats: { blobs: 120, blob_bytes: 3 * 1024 * 1024, roots: [{ path: '/home/frank/meetings', files: 40, exists: true, scanned_ms: 1 }, { path: '/home/frank/.openclaw/workspace', files: 23000, exists: true, scanned_ms: 1 }] },
  draftRoot: '', saving: false, error: null, rebuild: { running: false, root: null },
};

test('lists roots with counts and remove buttons, add form, prune textarea, cache size, rebuild', () => {
  const h = changesSettingsHtml(model);
  assert.ok(h.includes('/home/frank/meetings') && h.includes('40 files'));
  assert.ok(h.includes('data-act="changesRemoveRoot"') && h.includes('data-arg="/home/frank/meetings"'));
  assert.ok(h.includes('data-model="changesRootDraft"') && h.includes('data-act="changesAddRoot"'));
  assert.ok(h.includes('data-model="changesPruneDraft"') && h.includes('.git\ntmp'));
  assert.ok(h.includes('3.0 MB') && h.includes('120 cached copies'));
  assert.ok(h.includes('data-act="changesRebuild"') && !h.includes('disabled'));
  assert.ok(!h.includes('—'));
});

test('missing root and running rebuild are shown honestly', () => {
  const m = { ...model, stats: { ...model.stats, roots: [{ path: '/gone', files: 0, exists: false, scanned_ms: 0 }] }, rebuild: { running: true, root: '/x' } };
  const h = changesSettingsHtml(m);
  assert.ok(h.includes('not found on disk'));
  assert.ok(h.includes('Rebuilding /x') && h.includes('disabled'));
});
