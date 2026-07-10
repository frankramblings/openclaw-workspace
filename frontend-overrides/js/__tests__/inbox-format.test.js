import { test } from 'node:test';
import assert from 'node:assert';
import { ageLabel, bodyIsPath } from '../redesign/live/inbox-logic.js';
import { mInbox } from '../redesign/mobile/mobile-surfaces.js';
import { renderCenter } from '../redesign/surfaces.js';

test('ageLabel says now for fresh items instead of 0h', () => {
  assert.equal(ageLabel(0), 'now');
  assert.equal(ageLabel(0.4), 'now');
  assert.equal(ageLabel(5), '5h');
  assert.equal(ageLabel(36), '2d');
});

test('bodyIsPath detects ingest source pointers, not prose', () => {
  assert.equal(bodyIsPath('99_Ingest/Processed/gmail_important_latest.jsonl#L2'), true);
  assert.equal(bodyIsPath('99_Ingest/Processed/asana_tasks_latest.json#L2-L9'), true);
  assert.equal(bodyIsPath('Hey, can you review the doc before Friday?'), false);
  assert.equal(bodyIsPath('Boosted Social Campaign Brief'), false);
  assert.equal(bodyIsPath(''), false);
});

const item = (body) => ({
  id: '1', source: 'gmail', group: 'needs', src: 'GMAIL', srcColor: '#fff', srcBg: '#333',
  who: 'Dana Hu', time: 'now', body, actions: [], rec: null, meta: {},
  primary: 'Open', secondary: 'Mark read', suggest: 'Archive', unread: false,
});

test('mobile inbox renders path bodies as a source line, prose as body', () => {
  const s = (b) => ({ dismissed: [], live: { inbox: { items: [item(b)] } } });
  assert.match(mInbox(s('99_Ingest/Processed/gmail_important_latest.jsonl#L2')), /body-src/);
  assert.doesNotMatch(mInbox(s('Please review the brief.')), /body-src/);
});

test('desktop inbox renders path bodies as a source line', () => {
  const s = { surface: 'inbox', dismissed: [], live: { inbox: { items: [item('99_Ingest/Processed/gmail_important_latest.jsonl#L2')] } } };
  assert.match(renderCenter(s), /body-src/);
});
