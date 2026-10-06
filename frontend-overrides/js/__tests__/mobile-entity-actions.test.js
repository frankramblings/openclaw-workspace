import { test } from 'node:test';
import assert from 'node:assert';
import { mInbox } from '../redesign/mobile/mobile-surfaces.js';
import { cardActions, entitySourcePath } from '../redesign/live/inbox-logic.js';

const entity = (over = {}) => ({
  id: 'automation suite',
  source: 'entities',
  group: 'needs',
  src: 'ENTITIES',
  srcColor: '#fff',
  srcBg: '#000',
  who: 'Automation Suite',
  time: '—',
  body: '99_Ingest/Processed/gmail_important_latest.jsonl#L13',
  actions: ['confirm', 'reclassify', 'not_entity', 'open', 'gary', 'snooze', 'dismiss'],
  meta: {
    name: 'Automation Suite',
    guessType: 'project',
    file: '99_Ingest/Processed/gmail_important_latest.jsonl#L13',
  },
  ...over,
});

test('mobile entity card renders concrete classification choices instead of a bare reclassify action', () => {
  const html = mInbox({ dismissed: [], live: { inbox: { items: [entity()] } } });

  assert.match(html, /data-act="confirm" data-arg="automation suite"[^>]*>Confirm project</);
  assert.match(html, /data-act="reclassify" data-arg="automation suite:person"[^>]*>Person</);
  assert.match(html, /data-act="reclassify" data-arg="automation suite:org"[^>]*>Org</);
  assert.doesNotMatch(html, /data-act="reclassify" data-arg="automation suite"(?:\s|>)/);
});

test('mobile entity Open targets the originating workspace evidence file', () => {
  const html = mInbox({ dismissed: [], live: { inbox: { items: [entity()] } } });

  assert.match(html, /data-act="wsOpenFile" data-arg="OpenClaw_Vault\/99_Ingest\/Processed\/gmail_important_latest\.jsonl" data-root="workspace"/);
});

test('entity right-swipe primary action is confirm, not dismiss', () => {
  assert.deepEqual(cardActions(entity()).find((a) => a.role === 'primary'), {
    action: 'confirm', label: 'Confirm project', role: 'primary',
  });
});

test('entitySourcePath strips line anchors and rejects unsafe references', () => {
  assert.equal(entitySourcePath(entity()), 'OpenClaw_Vault/99_Ingest/Processed/gmail_important_latest.jsonl');
  assert.equal(entitySourcePath(entity({ meta: { file: '../secret.env' } })), null);
});
