// FINAL review, important 4a. The service worker suppressed the banner only
// for `kind === 'turn'`, but backend/task_push._payload sends `kind: "task"`.
// With one live push subscription on the box, EVERY finished job — every
// bin/job run, every pending-token resolve, every research completion —
// banners the phone, including while the user is looking at the very row that
// just turned green. The complaint that started this project was "I would much
// prefer no ping and an honest, reliable progress bar"; as shipped this branch
// would deliver MORE pings than before.
//
// frontend-vendor/sw.js is HAND-MAINTAINED source (only its PRECACHE array is
// filled in at deploy time by scripts/sync-frontend.sh at the
// `/*__PRECACHE__*/` marker), so it is edited here and exercised here. It is
// not an ES module, so it is run in a node:vm context with a stubbed service
// worker global scope and its 'push' listener is invoked for real.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SW_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'frontend-vendor', 'sw.js');

function loadSw({ visible }) {
  const listeners = {};
  const shown = [];
  const badges = [];
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    caches: {
      open: async () => ({ put: async () => {}, match: async () => undefined }),
      keys: async () => [],
      match: async () => undefined,
      delete: async () => true,
    },
    fetch: async () => ({ ok: false }),
    navigator: {
      setAppBadge: async (n) => { badges.push(n); },
      clearAppBadge: async () => { badges.push(0); },
    },
  };
  sandbox.self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {},
    clients: {
      matchAll: async () => [{ visibilityState: visible ? 'visible' : 'hidden', url: '/' }],
      claim: async () => {},
      openWindow: async () => {},
    },
    registration: {
      showNotification: async (title, opts) => { shown.push({ title, ...opts }); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'sw.js' });
  return { listeners, shown, badges };
}

async function firePush(env, data) {
  let waited = null;
  env.listeners.push({ data: { json: () => data }, waitUntil: (p) => { waited = p; } });
  await waited;
}

const taskPush = { title: 'Finished', body: 'BwG 571 render finished.', kind: 'task', tag: 'task-x', badge: 2 };

test('a task push does NOT banner while the app is visible', async () => {
  const env = loadSw({ visible: true });
  await firePush(env, taskPush);
  assert.deepEqual(env.shown, [], 'no banner while the user is already watching the row');
  assert.deepEqual(env.badges, [2], 'the badge still updates');
});

test('a task push DOES banner when the app is backgrounded', async () => {
  const env = loadSw({ visible: false });
  await firePush(env, taskPush);
  assert.equal(env.shown.length, 1);
  assert.equal(env.shown[0].title, 'Finished');
  assert.deepEqual(env.badges, [2]);
});

test('turn pushes keep their existing visible-suppression (no regression)', async () => {
  const env = loadSw({ visible: true });
  await firePush(env, { title: 'Gary', body: 'reply', kind: 'turn', tag: 't', badge: 0 });
  assert.deepEqual(env.shown, []);
});

test('other push kinds are still shown while visible (guard against over-suppressing)', async () => {
  const env = loadSw({ visible: true });
  await firePush(env, { title: 'Reminder', body: 'x', kind: 'reminder', tag: 'r', badge: 1 });
  assert.equal(env.shown.length, 1);
});
