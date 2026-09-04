// prepare-public.sh must build the `public` branch WITHOUT touching the
// working tree or HEAD. An earlier version deleted gitignored working files
// (all of docs/superpowers/) on every real run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('../../', import.meta.url).pathname;

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'prep-public-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const f of ['prepare-public.sh', 'publish-scan.sh', 'publish-scan-patterns.txt']) {
    copyFileSync(join(ROOT, 'scripts', f), join(dir, 'scripts', f));
  }
  writeFileSync(join(dir, 'README.md'), '# hello\n');
  mkdirSync(join(dir, 'ralph'), { recursive: true });
  writeFileSync(join(dir, 'ralph', 'x.md'), 'internal\n');
  writeFileSync(join(dir, '.gitignore'), '/docs/superpowers/\n');
  mkdirSync(join(dir, 'docs', 'superpowers'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'superpowers', 'secret-plan.md'), 'private notes\n');
  git(dir, 'add', 'README.md', 'ralph/x.md', '.gitignore', 'scripts/prepare-public.sh',
    'scripts/publish-scan.sh', 'scripts/publish-scan-patterns.txt');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

const runScript = (dir, ...args) =>
  spawnSync('bash', ['scripts/prepare-public.sh', ...args], { cwd: dir, encoding: 'utf8' });

test('a real build never touches the working tree or HEAD', () => {
  const dir = fixture();
  const r = runScript(dir, '--yes');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(dir, 'docs', 'superpowers', 'secret-plan.md')),
    'the gitignored working file must survive the publish build');
  assert.equal(git(dir, 'branch', '--show-current').stdout.trim(), 'main');
  const files = git(dir, 'ls-tree', '-r', '--name-only', 'public').stdout.split('\n').filter(Boolean);
  assert.ok(files.includes('README.md'));
  assert.ok(files.some((f) => f.startsWith('scripts/')));
  assert.ok(!files.some((f) => f.startsWith('ralph/')), 'ralph/ must not be published');
  assert.ok(!files.some((f) => f.startsWith('docs/superpowers/')), 'internal docs must not be published');
  assert.equal(git(dir, 'rev-list', '--count', 'public').stdout.trim(), '1');
});

test('--check passes and builds nothing', () => {
  const dir = fixture();
  const r = runScript(dir, '--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.notEqual(git(dir, 'rev-parse', '--verify', 'public').status, 0, 'no public branch from --check');
  assert.equal(git(dir, 'branch', '--show-current').stdout.trim(), 'main');
});
