import { test } from 'node:test';
import assert from 'node:assert';
import { detailEndpoint } from '../redesign/live/inbox-detail.js';

test('detailEndpoint: camelCase slack item yields correct endpoint', () => {
  const item = {
    id: 'msg123',
    source: 'slack',
    meta: {
      channelId: 'C12345',
      threadTs: '1234567890.123456',
      channel: 'general',
    }
  };
  const result = detailEndpoint(item);
  assert.ok(result, 'endpoint should not be null');
  assert.equal(result.kind, 'slack');
  assert.match(result.url, /channel_id=C12345/);
  assert.match(result.url, /thread_ts=1234567890/);
});

test('detailEndpoint: meta.channel (display name) is NEVER used as the id → null', () => {
  const item = {
    id: 'msg456',
    source: 'slack',
    meta: {
      // meta.channel is always a display name (backend/inbox/sources/slack.py),
      // never a real Slack conversation id — there is no legacy snake_case
      // channel_id key backing it, unlike threadTs/thread_ts. Falling back to
      // it would send a name to conversations.replies, which requires a real
      // channel id, and the fetch would fail server-side on any handle_map miss.
      channel: 'random',
      thread_ts: '1111111111.111111',
    }
  };
  const result = detailEndpoint(item);
  assert.equal(result, null);
});

test('detailEndpoint: missing channelId/channel → null', () => {
  const item = {
    id: 'msg789',
    source: 'slack',
    meta: {
      threadTs: '1234567890.123456',
    }
  };
  const result = detailEndpoint(item);
  assert.equal(result, null);
});

test('detailEndpoint: missing threadTs/thread_ts → null', () => {
  const item = {
    id: 'msg789',
    source: 'slack',
    meta: {
      channelId: 'C12345',
      channel: 'general',
    }
  };
  const result = detailEndpoint(item);
  assert.equal(result, null);
});

test('detailEndpoint: asana item unaffected', () => {
  const item = {
    id: 'gid123',
    source: 'asana',
    meta: {}
  };
  const result = detailEndpoint(item);
  assert.ok(result, 'asana endpoint should exist');
  assert.equal(result.kind, 'asana');
  assert.match(result.url, /gid123/);
});

test('detailEndpoint: gmail item unaffected', () => {
  const item = {
    id: 'msg123',
    source: 'gmail',
    meta: {
      uid: 'uid456'
    }
  };
  const result = detailEndpoint(item);
  assert.ok(result, 'gmail endpoint should exist');
  assert.equal(result.kind, 'gmail');
  assert.match(result.url, /uid456/);
});

test('detailEndpoint: null item → null', () => {
  const result = detailEndpoint(null);
  assert.equal(result, null);
});

test('detailEndpoint: missing meta → null for slack', () => {
  const item = {
    id: 'msg123',
    source: 'slack',
  };
  const result = detailEndpoint(item);
  assert.equal(result, null);
});
