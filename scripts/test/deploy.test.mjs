import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('../../', import.meta.url).pathname;

function stubDir(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-stubs-'));
  const log = join(dir, 'log');
  const mk = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`); chmodSync(p, 0o755); };
  mk('python', 'exit ${STUB_PYTEST_EXIT:-0}');
  mk('node', 'exit ${STUB_NODE_EXIT:-0}');
  // The preflight probe `sudo -n -u marissa true` is not logged as an action.
  mk('sudo', 'if [ "$1" = "-n" ] && [ "$2" = "true" ]; then exit 0; fi; if [ "$1" = "-n" ] && [ "$2" = "-u" ]; then shift 3; if [ "$1" != "true" ]; then echo "as-marissa $*" >> "' + log + '"; fi; if [ "$1" = "cat" ]; then echo "${STUB_INFLIGHT:-{\\"inflight\\":{}}}"; fi; if [ "$1" = "bash" ]; then echo "${STUB_M_SHA:-0123456789abcdef0123456789abcdef01234567}"; fi; exit 0; fi; exit 0');
  mk('systemctl', 'exit 0');
  mk('curl', 'echo "{\\"ok\\":true}"; exit 0');
  mk('git', 'case "$1" in rev-parse) echo "abc1234";; diff) echo "${STUB_GW_DIFF:-}";; status) echo "";; branch) echo "main";; *) ;; esac; exit 0');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'claude-live-session-x.js'), overrides.marker === false ? 'nope' : '/*CLI_STEER*/');
  return { dir, log };
}

function run(args, { dir, log }, env = {}) {
  const r = spawnSync('bash', [join(ROOT, 'scripts/deploy.sh'), ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEPLOY_LOG: log,
      DEPLOY_PYTHON: join(dir, 'python'), DEPLOY_NODE: join(dir, 'node'), DEPLOY_SUDO: join(dir, 'sudo'),
      DEPLOY_SYSTEMCTL: join(dir, 'systemctl'), DEPLOY_CURL: join(dir, 'curl'), DEPLOY_GIT: join(dir, 'git'),
      DEPLOY_DIST_GLOB: join(dir, 'dist', 'claude-live-session-*.js'), DEPLOY_MARISSA_HOME: dir,
      DEPLOY_SCAN_CMD: 'true', DEPLOY_SYNC_CMD: 'true', DEPLOY_PUBLISH_CMD: 'true', DEPLOY_PREFLIGHT_CLEAN: '1', ...env },
  });
  return { ...r, lines: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

const idx = (lines, re) => lines.findIndex((l) => re.test(l));

test('dry run plans every step in order and restarts nothing', () => {
  const s = stubDir();
  const r = run(['--dry-run'], s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout;
  const order = ['gate:backend', 'gate:frontend', 'gate:scan', 'frank:sync', 'frank:restart', 'frank:smoke', 'publish', 'marissa:backup', 'marissa:reset', 'marissa:sync', 'marissa:restart', 'marissa:smoke', 'summary'];
  let last = -1;
  for (const step of order) { const i = out.indexOf(`[${step}]`); assert.ok(i > last, `step ${step} out of order or missing`); last = i; }
  assert.equal(r.lines.filter((l) => /^systemctl/.test(l)).length, 0, 'no systemctl in dry run');
});

test('a failing gate stops before any restart', () => {
  const s = stubDir();
  const r = run([], s, { STUB_PYTEST_EXIT: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(idx(r.lines, /^systemctl/), -1);
  assert.equal(idx(r.lines, /as-marissa/), -1);
});

test('--skip-marissa skips her steps', () => {
  const s = stubDir();
  const r = run(['--skip-marissa'], s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(idx(r.lines, /as-marissa/), -1);
  assert.ok(r.stdout.includes('[frank:restart]'));
});

test('gateway restarts only for a gateway-side change, after idle', () => {
  const quiet = run([], stubDir());
  assert.equal(quiet.lines.filter((l) => /systemctl restart openclaw-gateway-marissa/.test(l)).length, 0);
  const changed = run([], stubDir(), { STUB_GW_DIFF: 'deploy/gateway-patches/claude-cli-steer.py' });
  assert.equal(changed.lines.filter((l) => /systemctl restart openclaw-gateway-marissa/.test(l)).length, 1);
  const busy = run(['--gateway-wait', '1'], stubDir(), { STUB_GW_DIFF: 'deploy/gateway-patches/x', STUB_INFLIGHT: '{"inflight":{"k":1}}' });
  assert.equal(busy.lines.filter((l) => /systemctl restart openclaw-gateway-marissa/.test(l)).length, 0);
  assert.ok(busy.stdout.includes('SKIPPED gateway restart'));
});

test('missing patch marker also triggers the gateway restart', () => {
  const r = run([], stubDir({ marker: false }));
  assert.equal(r.lines.filter((l) => /systemctl restart openclaw-gateway-marissa/.test(l)).length, 1);
});

test('--skip-tests needs --i-know', () => {
  assert.notEqual(run(['--skip-tests'], stubDir()).status, 0);
  assert.equal(run(['--skip-tests', '--i-know', '--dry-run'], stubDir()).status, 0);
  assert.equal(run(['--gateway-wait', 'soon', '--dry-run'], stubDir()).status, 2);
});
