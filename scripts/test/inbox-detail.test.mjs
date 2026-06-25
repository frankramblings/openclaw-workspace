import assert from 'node:assert/strict';
import { detailEndpoint } from '../../frontend-overrides/js/redesign/live/inbox-detail.js';
assert.equal(detailEndpoint({ source: 'asana', id: '7', meta: {} }).url, '/api/inbox/asana/task?gid=7');
assert.equal(detailEndpoint({ source: 'slack', meta: { channel: 'C1', thread_ts: '1.2' } }).url,
  '/api/inbox/slack/thread?channel_id=C1&thread_ts=1.2');
assert.equal(detailEndpoint({ source: 'gmail', meta: { uid: '9' } }).url, '/api/email/read/9?mark_seen=false');
assert.equal(detailEndpoint({ source: 'documents', meta: {} }), null);
console.log('inbox-detail: all assertions OK');
