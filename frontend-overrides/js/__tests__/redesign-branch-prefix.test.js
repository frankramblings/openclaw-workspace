import { test } from 'node:test';
import assert from 'node:assert';
import { chatSurface } from '../redesign/surfaces.js';

test('branchPrefix messages render above the live transcript, tagged as carried', () => {
  const s = {
    surface: 'chat',
    branchPrefix: [
      { id: 'p1', role: 'user', text: 'earlier question', time: '08:00' },
      { id: 'p2', role: 'assistant', text: 'earlier answer', time: '08:01' },
    ],
    live: {
      chat: {
        thread: [
          { id: 'u1', role: 'user', text: 'new question', time: '09:00' },
        ],
      },
    },
  };
  const html = chatSurface(s);

  // both prefix and live messages present
  assert.match(html, /earlier question/);
  assert.match(html, /earlier answer/);
  assert.match(html, /new question/);

  // prefix comes before live in document order
  const prefixIdx = html.indexOf('earlier question');
  const liveIdx = html.indexOf('new question');
  assert.ok(prefixIdx >= 0 && liveIdx >= 0 && prefixIdx < liveIdx, 'prefix must render before live messages');

  // carried messages get the msg-carried class
  const p1Idx = html.indexOf('data-msg-id="p1"');
  const p2Idx = html.indexOf('data-msg-id="p2"');
  assert.ok(p1Idx >= 0 && p2Idx >= 0);

  // grab a window around each carried message to check its class
  const around = (idx) => html.slice(Math.max(0, idx - 400), idx + 20);
  assert.match(around(p1Idx), /msg-carried/, 'first carried message should have msg-carried class');
  assert.match(around(p2Idx), /msg-carried/, 'second carried message should have msg-carried class');

  // only the first carried message gets msg-carried-first
  assert.match(around(p1Idx), /msg-carried-first/, 'first carried message should be tagged msg-carried-first');
  assert.doesNotMatch(around(p2Idx), /msg-carried-first/, 'second carried message should not be tagged msg-carried-first');

  // live (non-carried) message must not get the carried class
  const liveMsgIdx = html.indexOf('data-msg-id="u1"');
  assert.doesNotMatch(around(liveMsgIdx), /msg-carried/, 'live message must not be tagged carried');
});

test('the chat header shows the Project › Title prefix and a parent link when they resolve', () => {
  const s = {
    surface: 'chat',
    live: {
      projects: [{ id: 'projA', name: 'Local AI' }],
      chat: {
        title: 'Follow-up question',
        subtitle: 'gpt-5',
        folder: 'projA',
        parentId: 'parent1',
        sessions: [{ id: 'parent1', name: 'Original thread' }],
        thread: [],
      },
    },
  };
  const html = chatSurface(s);
  const ttl = html.slice(html.indexOf('<div class="ttl">'), html.indexOf('</div>', html.indexOf('<div class="ttl">')) + 6);
  assert.ok(ttl.includes('<span class="ttl-proj">Local AI ›</span>'));
  const sub = html.slice(html.indexOf('<div class="sub">'));
  assert.match(sub, /↳ from/);
  assert.match(sub, /data-act="selectSession" data-arg="parent1"/);
});

test('the chat header omits the project prefix and parent link when neither resolves', () => {
  const s = {
    surface: 'chat',
    live: {
      chat: {
        title: 'New chat',
        subtitle: '',
        thread: [],
      },
    },
  };
  const html = chatSurface(s);
  assert.ok(!html.includes('ttl-proj'));
  assert.ok(!html.includes('sub-parent'));
});
