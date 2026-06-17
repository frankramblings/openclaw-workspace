// frontend-overrides/js/__tests__/workspace-terminal-config.test.js
// Same harness as workspace-terminal-layout.test.js: run the classic script in a
// vm sandbox with a fake window, then read window.WTTermConfig.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../workspace-terminal-config.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(code, sandbox);
const C = sandbox.window.WTTermConfig;

test('font stack leads with the Nerd Font', () => {
  assert.ok(C.FONT_STACK.startsWith('"JetBrainsMono Nerd Font"'));
});

test('buildTermOptions enables proposed API and uses the font stack', () => {
  const o = C.buildTermOptions(() => '');
  assert.equal(o.allowProposedApi, true);
  assert.equal(o.fontFamily, C.FONT_STACK);
  assert.equal(o.theme.background, '#0d1117'); // default palette bg
});

test('buildTheme lets a workspace CSS var override only the background', () => {
  const t = C.buildTheme((name) => (name === '--wt-term-bg' ? '  #001018  ' : ''));
  assert.equal(t.background, '#001018');        // trimmed + applied
  assert.equal(t.green, '#7ee787');             // palette otherwise intact
});
