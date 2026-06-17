# Terminal Slickness Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-chat attached terminal feel slick — GPU-fast rendering, a proper font with Nerd-Font/powerline glyphs, a deliberate dark theme, clickable links, in-scrollback search, and correct emoji/CJK width.

**Architecture:** The terminal is a pure-browser xterm.js instance (no Electron) loaded as vendored UMD scripts via `injectScript`, with a Python `pty.fork()` backend over a WebSocket. This batch is **frontend-only** and machine-independent — it vendors four more official `@xterm/addon-*` UMD builds + a Nerd Font webfont, factors terminal options into a unit-testable pure module, and wires them into the existing panel manager. The webgl renderer is the speed lever; ligatures are intentionally **out of scope** (addon-ligatures requires Node/Electron font-file access and cannot work in a browser — confirmed decision: speed renderer over ligatures).

**Tech Stack:** xterm.js 5.x (vendored UMD), `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`, JetBrainsMono Nerd Font (woff2), `node:test` for unit tests.

## Global Constraints

- **No build step / no ES modules for vendored assets.** Every addon is a UMD build loaded via the existing `injectScript()` pattern that sets a `window.*` global, exactly like `addon-fit.js`. (Per the ESM-double-load lesson, do not `?v=` or `import` these.)
- **Addon versions must match the vendored xterm core major (5.x).** Use the latest patch of each `@xterm/addon-*` (all target `xterm ^5.0.0`).
- **Vendored files live in `frontend-overrides/js/vendor/xterm/`** and are served at `/static/js/vendor/xterm/` after `scripts/sync-frontend.sh` copies them into `frontend/` (gitignored build output). The classic config script lives at `frontend-overrides/js/workspace-terminal-config.js`, served at `/static/js/workspace-terminal-config.js`.
- **No headless Chrome for verification** (cold-starts thrash the box). Rendering acceptance = `node --check` + `curl` byte checks + the user eyeballing a real terminal panel.
- **Font = JetBrainsMono Nerd Font; ligatures OFF; dark GitHub/Hermes palette** (the exact palette the user signed off on in the font-compare preview).
- **Frontend dir is `repo_root/frontend`** (no `WORKSPACE_FRONTEND_DIR` pinned in the live LaunchAgent). Loopback origin for curl checks: `http://127.0.0.1:8800`.

---

### Task 1: Vendor the four addon UMD builds

**Files:**
- Create: `frontend-overrides/js/vendor/xterm/addon-webgl.js`
- Create: `frontend-overrides/js/vendor/xterm/addon-search.js`
- Create: `frontend-overrides/js/vendor/xterm/addon-web-links.js`
- Create: `frontend-overrides/js/vendor/xterm/addon-unicode11.js`

**Interfaces:**
- Produces: browser globals `window.WebglAddon`, `window.SearchAddon`, `window.WebLinksAddon`, `window.Unicode11Addon` — each an object whose `.<Name>Addon` property is the constructor (e.g. `new window.WebglAddon.WebglAddon()`). **The exact global key is verified in Step 2, not assumed.**

- [ ] **Step 1: Fetch the UMD builds from npm into the vendor dir**

```bash
cd /Users/admin/openclaw-workspace
TMP=$(mktemp -d)
for pkg in addon-webgl addon-search addon-web-links addon-unicode11; do
  ( cd "$TMP" && npm pack "@xterm/$pkg" >/dev/null 2>&1 )
  tar -xzf "$TMP/xterm-$pkg-"*.tgz -C "$TMP"
  cp "$TMP/package/lib/$pkg.js" "frontend-overrides/js/vendor/xterm/$pkg.js"
  rm -rf "$TMP/package"
done
rm -rf "$TMP"
ls -la frontend-overrides/js/vendor/xterm/addon-*.js
```
Expected: four new `addon-*.js` files listed alongside the existing `addon-fit.js`.

- [ ] **Step 2: Verify each UMD's global key and constructor name**

```bash
cd /Users/admin/openclaw-workspace
for f in addon-webgl addon-search addon-web-links addon-unicode11; do
  echo "== $f =="
  node -e "const m=require('./frontend-overrides/js/vendor/xterm/$f.js'); console.log(Object.keys(m))"
done
```
The vendored files are UMD (`typeof exports==='object'` branch), so `require()` returns the module exports directly. Expected: prints the exported constructor names, e.g. `[ 'WebglAddon' ]`, `[ 'SearchAddon' ]`, `[ 'WebLinksAddon' ]`, `[ 'Unicode11Addon' ]`. These are also the browser global keys (e.g. `window.WebglAddon.WebglAddon`). **If any differ, record the actual name — Task 4 must use it.**

- [ ] **Step 3: Confirm `node --check` passes on each (valid JS, not truncated)**

```bash
cd /Users/admin/openclaw-workspace
for f in addon-webgl addon-search addon-web-links addon-unicode11; do node --check "frontend-overrides/js/vendor/xterm/$f.js" && echo "ok $f"; done
```
Expected: `ok addon-webgl` … `ok addon-unicode11` (four lines, no syntax errors).

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/vendor/xterm/addon-webgl.js frontend-overrides/js/vendor/xterm/addon-search.js frontend-overrides/js/vendor/xterm/addon-web-links.js frontend-overrides/js/vendor/xterm/addon-unicode11.js
git commit -m "feat(terminal): vendor webgl/search/web-links/unicode11 xterm addons"
```

---

### Task 2: Vendor the JetBrainsMono Nerd Font webfont + @font-face

**Files:**
- Create: `frontend-overrides/js/vendor/xterm/JetBrainsMonoNF-Regular.woff2`
- Create: `frontend-overrides/js/vendor/xterm/JetBrainsMonoNF-Bold.woff2`
- Create: `frontend-overrides/js/vendor/xterm/wt-fonts.css`

**Interfaces:**
- Produces: a CSS `@font-face` family named exactly `"JetBrainsMono Nerd Font"` (regular 400 + bold 700), referenced by `WTTermConfig.FONT_STACK` in Task 3 and injected in Task 4.

- [ ] **Step 1: Download the patched TTFs and convert to woff2**

```bash
cd /Users/admin/openclaw-workspace
TMP=$(mktemp -d)
curl -sL -o "$TMP/jbm.tar.xz" \
  https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.1/JetBrainsMono.tar.xz
tar -xf "$TMP/jbm.tar.xz" -C "$TMP"
# fonttools+brotli convert TTF -> woff2 (use the workspace venv python)
.venv/bin/pip install -q fonttools brotli
for pair in "Regular:JetBrainsMonoNF-Regular" "Bold:JetBrainsMonoNF-Bold"; do
  style="${pair%%:*}"; out="${pair##*:}"
  src=$(ls "$TMP"/JetBrainsMonoNerdFont-"$style".ttf 2>/dev/null | head -1)
  .venv/bin/python -c "from fontTools.ttLib import TTFont; f=TTFont('$src'); f.flavor='woff2'; f.save('frontend-overrides/js/vendor/xterm/$out.woff2')"
done
rm -rf "$TMP"
ls -la frontend-overrides/js/vendor/xterm/JetBrainsMonoNF-*.woff2
```
Expected: two `.woff2` files, each on the order of a few hundred KB.

- [ ] **Step 2: Write `wt-fonts.css`**

```css
/* Vendored JetBrainsMono Nerd Font for the attached terminal. Full (non-subset)
   so Nerd-Font PUA glyphs (powerline, dev icons) are preserved. */
@font-face {
  font-family: "JetBrainsMono Nerd Font";
  src: url("/static/js/vendor/xterm/JetBrainsMonoNF-Regular.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "JetBrainsMono Nerd Font";
  src: url("/static/js/vendor/xterm/JetBrainsMonoNF-Bold.woff2") format("woff2");
  font-weight: 700;
  font-display: swap;
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/vendor/xterm/JetBrainsMonoNF-Regular.woff2 frontend-overrides/js/vendor/xterm/JetBrainsMonoNF-Bold.woff2 frontend-overrides/js/vendor/xterm/wt-fonts.css
git commit -m "feat(terminal): vendor JetBrainsMono Nerd Font webfont + @font-face"
```

---

### Task 3: Testable terminal-config module (theme + options)

**Files:**
- Create: `frontend-overrides/js/workspace-terminal-config.js`
- Test: `frontend-overrides/js/__tests__/workspace-terminal-config.test.js`

**Interfaces:**
- Produces: global `window.WTTermConfig` with:
  - `FONT_STACK` (string) — `'"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, Menlo, monospace'`
  - `buildTheme(cssVarLookup)` → xterm `ITheme` object; if `cssVarLookup('--wt-term-bg')` returns a non-empty string, it overrides `theme.background`.
  - `buildTermOptions(cssVarLookup)` → `{ cursorBlink, fontSize, fontFamily, allowProposedApi, theme }`. `allowProposedApi` MUST be `true` (the unicode11 addon requires it). `fontFamily` MUST equal `FONT_STACK`.
- Consumed by Task 4's `ensureTermBuilt`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && node --test frontend-overrides/js/__tests__/workspace-terminal-config.test.js`
Expected: FAIL — cannot read `WTTermConfig` of undefined (module doesn't exist yet).

- [ ] **Step 3: Write the module**

```js
// frontend-overrides/js/workspace-terminal-config.js
// Classic <script> (like workspace-terminal-layout.js): sets window.WTTermConfig.
// Pure, DOM-free helpers so they're unit-testable via the vm sandbox pattern.
(function () {
  'use strict';

  // GitHub-dark / Hermes-aligned palette the user signed off on in the
  // font-compare preview. xterm ITheme.
  var THEME = {
    background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9',
    cursorAccent: '#0d1117', selectionBackground: 'rgba(56,139,253,0.30)',
    black: '#161b22', red: '#ff7b72', green: '#7ee787', yellow: '#e3b341',
    blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#c9d1d9',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#aff5b4',
    brightYellow: '#f2cc60', brightBlue: '#a5d6ff', brightMagenta: '#e2c5ff',
    brightCyan: '#a2e9f0', brightWhite: '#f0f6fc'
  };

  var FONT_STACK =
    '"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, Menlo, monospace';

  // Let the active workspace theme override the terminal background only, so the
  // panel never clashes with a light/alt Hermes theme. cssVarLookup is injected
  // for testability; in the browser it reads :root computed styles.
  function buildTheme(cssVarLookup) {
    var theme = {};
    for (var k in THEME) { if (THEME.hasOwnProperty(k)) theme[k] = THEME[k]; }
    var bg = cssVarLookup && cssVarLookup('--wt-term-bg');
    if (bg && bg.trim()) theme.background = bg.trim();
    return theme;
  }

  function buildTermOptions(cssVarLookup) {
    return {
      cursorBlink: true,
      fontSize: 13,
      fontFamily: FONT_STACK,
      allowProposedApi: true,           // required by the unicode11 addon
      theme: buildTheme(cssVarLookup)
    };
  }

  window.WTTermConfig = {
    FONT_STACK: FONT_STACK,
    buildTheme: buildTheme,
    buildTermOptions: buildTermOptions
  };
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && node --test frontend-overrides/js/__tests__/workspace-terminal-config.test.js`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/workspace-terminal-config.js frontend-overrides/js/__tests__/workspace-terminal-config.test.js
git commit -m "feat(terminal): testable WTTermConfig (Nerd Font stack + dark theme)"
```

---

### Task 4: Wire addons, font, and theme into the panel manager

**Files:**
- Modify: `frontend-overrides/js/workspace-terminal.js` (`ensureXterm` ~L64-68; `ensureTermBuilt` ~L128-140)

**Interfaces:**
- Consumes: `window.WTTermConfig.buildTermOptions` (Task 3); globals `WebglAddon`, `SearchAddon`, `WebLinksAddon`, `Unicode11Addon` (Task 1, exact names from Task 1 Step 2); `wt-fonts.css` (Task 2).
- Produces: each panel object `p` gains `p.search` (a `SearchAddon` instance) used by Task 5.

- [ ] **Step 1: Extend `ensureXterm()` to inject the new CSS/JS**

Replace the body of `ensureXterm` (currently L64-68) with:

```js
  async function ensureXterm() {
    injectCss(VENDOR + 'xterm.css');
    injectCss(VENDOR + 'wt-fonts.css');
    if (!window.Terminal) await injectScript(VENDOR + 'xterm.js');
    if (!window.FitAddon) await injectScript(VENDOR + 'addon-fit.js');
    if (!window.WebglAddon) await injectScript(VENDOR + 'addon-webgl.js');
    if (!window.SearchAddon) await injectScript(VENDOR + 'addon-search.js');
    if (!window.WebLinksAddon) await injectScript(VENDOR + 'addon-web-links.js');
    if (!window.Unicode11Addon) await injectScript(VENDOR + 'addon-unicode11.js');
    if (!window.WTTermConfig) await injectScript('/static/js/workspace-terminal-config.js');
  }
```

Note: `injectCss` currently early-returns if any `link[data-wt-css]` exists, so it loads only the first sheet. Update `injectCss` to key off the href:

```js
  function injectCss(href) {
    if (document.querySelector('link[data-wt-css="' + href + '"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-wt-css', href);
    document.head.appendChild(l);
  }
```

- [ ] **Step 2: Rebuild terminal construction in `ensureTermBuilt()`**

Replace the `if (!p.term) { … }` block (currently L130-138) with:

```js
    if (!p.term) {
      const opts = window.WTTermConfig.buildTermOptions(function (name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name);
      });
      p.term = new window.Terminal(opts);

      p.fit = new window.FitAddon.FitAddon();
      p.term.loadAddon(p.fit);

      // Correct emoji/CJK cell width (requires allowProposedApi:true).
      p.term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      p.term.unicode.activeVersion = '11';

      // Clickable URLs + in-scrollback search (search box wired in Task 5).
      p.term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
      p.search = new window.SearchAddon.SearchAddon();
      p.term.loadAddon(p.search);

      p.term.open(p.screen);

      // GPU renderer — must load AFTER open(). Dispose on context loss so the
      // terminal silently falls back to the canvas/DOM renderer instead of dying.
      try {
        const webgl = new window.WebglAddon.WebglAddon();
        webgl.onContextLoss(function () { webgl.dispose(); });
        p.term.loadAddon(webgl);
      } catch (e) { /* webgl unavailable -> default renderer */ }

      p.term.onData((d) => sendTo(p, { type: 'input', data: d }));
      wireImageDrop(p);
    }
```

- [ ] **Step 3: Syntax-check the modified file**

Run: `cd /Users/admin/openclaw-workspace && node --check frontend-overrides/js/workspace-terminal.js`
Expected: no output (valid).

- [ ] **Step 4: Re-run the existing layout test (no regression)**

Run: `cd /Users/admin/openclaw-workspace && node --test frontend-overrides/js/__tests__/`
Expected: PASS — both the layout test and the new config test pass.

- [ ] **Step 5: Sync frontend, restart workspace, and acceptance-check in the browser**

```bash
cd /Users/admin/openclaw-workspace && scripts/sync-frontend.sh
# Reload the workspace (bootout+bootstrap; retry once on "5: I/O error"):
launchctl bootout gui/$(id -u)/ai.openclaw.workspace 2>/dev/null; sleep 1
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.workspace.plist
# Confirm new assets serve:
for a in addon-webgl.js addon-search.js addon-web-links.js addon-unicode11.js wt-fonts.css JetBrainsMonoNF-Regular.woff2; do
  printf '%s ' "$a"; curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8800/static/js/vendor/xterm/$a"; done
curl -s -o /dev/null -w "config %{http_code}\n" http://127.0.0.1:8800/static/js/workspace-terminal-config.js
```
Expected: every asset returns `200`. Then **user opens a chat terminal panel** and confirms: (a) text renders in JetBrains Mono (rounded zero, distinct `l/1/I`), (b) a printed URL is clickable, (c) emoji don't smear into the next cell, (d) scrolling fast output is smooth, (e) Nerd glyphs render if a powerline prompt is used. Ligatures are expected to render as plain characters — that's the chosen trade.

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/workspace-terminal.js
git commit -m "feat(terminal): webgl renderer + unicode11 + web-links + Nerd Font + theme"
```

---

### Task 5: Ctrl+F in-terminal search box

**Files:**
- Modify: `frontend-overrides/js/workspace-terminal.js` (panel markup in `createPanel` ~L76-89; `ensureTermBuilt` to wire the key handler)
- Modify: `frontend-overrides/js/vendor/xterm/xterm.css` is NOT edited — add styles to `wt-fonts.css`? No: add a small style block to the panel CSS. Use the existing workspace terminal stylesheet if present; otherwise append a `<style>` rule. (See Step 1.)

**Interfaces:**
- Consumes: `p.search` (Task 4) — `p.search.findNext(term)`, `p.search.findPrevious(term)`.

- [ ] **Step 1: Add a hidden find bar to the panel markup**

In `createPanel`, insert this line in the `el.innerHTML` template immediately after the `<div class="wt-screen"></div>` line:

```js
      '<div class="wt-find" hidden><input class="wt-find-input" type="text" placeholder="find" aria-label="Search terminal"><span class="wt-find-hint">↵ next · ⇧↵ prev · esc</span></div>' +
```

And after `screen: el.querySelector('.wt-screen'),` in the `p` object literal, add:

```js
      findBar: el.querySelector('.wt-find'),
      findInput: el.querySelector('.wt-find-input'),
```

- [ ] **Step 2: Wire Ctrl+F / Cmd+F to toggle the bar, and Enter/Esc inside it**

In `ensureTermBuilt`, after `p.term.open(p.screen);`, add:

```js
      p.term.attachCustomKeyEventHandler(function (ev) {
        if (ev.type === 'keydown' && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
          ev.preventDefault();
          p.findBar.hidden = false;
          p.findInput.focus();
          p.findInput.select();
          return false; // don't pass Ctrl/Cmd+F to the shell
        }
        return true;
      });
      p.findInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const q = p.findInput.value;
          if (q) { ev.shiftKey ? p.search.findPrevious(q) : p.search.findNext(q); }
        } else if (ev.key === 'Escape') {
          p.findBar.hidden = true;
          p.term.focus();
        }
      });
```

- [ ] **Step 3: Style the find bar (append to `wt-fonts.css`)**

```css
.wt-find {
  position: absolute; top: 38px; right: 10px; z-index: 1;
  display: flex; align-items: center; gap: 8px;
  background: #161b22; border: 1px solid #30363d; border-radius: 6px;
  padding: 4px 8px;
}
.wt-find-input {
  background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
  border-radius: 4px; padding: 2px 6px; font: inherit; width: 160px;
}
.wt-find-hint { color: #8b949e; font-size: 11px; }
```

- [ ] **Step 4: Syntax-check and re-run tests**

Run: `cd /Users/admin/openclaw-workspace && node --check frontend-overrides/js/workspace-terminal.js && node --test frontend-overrides/js/__tests__/`
Expected: valid + all tests pass.

- [ ] **Step 5: Acceptance — search in a live panel**

After `scripts/sync-frontend.sh` + workspace reload (commands as in Task 4 Step 5), **user** presses Ctrl+F in a terminal panel, types a string visible in scrollback, and confirms Enter highlights/scrolls to the next match and Shift+Enter the previous; Esc closes the bar and returns focus to the shell.

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/workspace-terminal.js frontend-overrides/js/vendor/xterm/wt-fonts.css
git commit -m "feat(terminal): Ctrl+F in-scrollback search box"
```

---

### Task 6: Remove the throwaway font-compare page

**Files:**
- Delete: `frontend/terminal-font-compare.html` (served copy)
- Delete: `/Users/admin/terminal-font-compare.html` (scratch original)

- [ ] **Step 1: Remove both files**

```bash
rm -f /Users/admin/openclaw-workspace/frontend/terminal-font-compare.html
rm -f /Users/admin/terminal-font-compare.html
ls /Users/admin/openclaw-workspace/frontend/terminal-font-compare.html 2>&1 | grep -q "No such file" && echo "removed"
```
Expected: `removed`. (No commit — `frontend/` is gitignored build output.)

---

## Deferred (separate follow-up plan): tmux durability swap

**Not in this batch.** The tmux swap is backend (`backend/terminals.py`) and must be **validated on the GEEKOM Ubuntu box post-migration**, behind a config flag. Outline for the follow-up plan:

- In `PtySession.start()`, fork `tmux new-session -A -s <sanitized session_key>` (attach-or-create) instead of a bare `$SHELL`, gated by a `terminal_tmux` config flag (default off until validated).
- `set -g status off` (embedded look), `window-size largest` + `aggressive-resize on` (shared Frank+Gary viewing).
- On `close_session`, `tmux kill-session -t <key>`; add a reaper for orphaned sessions; pin a stable socket path under the workspace data dir.
- Keep the existing server-side scrollback `buffer` + always-on reader (instant reconnect replay without `capture-pane`).
- The win tmux uniquely adds over today's reconnect-with-backlog: **survival across gateway/workspace restarts**.

---

## Self-Review

- **Spec coverage:** speed (Task 4 webgl) ✓; capability — search (Task 5), unicode width (Task 4), clickable links (Task 4) ✓; font + Nerd glyphs (Tasks 2,3,4) ✓; theme (Task 3,4) ✓; ligatures explicitly out of scope by user decision ✓; tmux deferred with a written outline ✓; cleanup (Task 6) ✓.
- **Placeholder scan:** every code step contains complete code; no TBD/TODO.
- **Type consistency:** `WTTermConfig.buildTermOptions`/`buildTheme`/`FONT_STACK` names match across Tasks 3–4; `p.search` produced in Task 4 and consumed in Task 5; addon global names are *verified* in Task 1 Step 2 rather than assumed (the one fragile point), and Task 4 is instructed to use the verified names.
