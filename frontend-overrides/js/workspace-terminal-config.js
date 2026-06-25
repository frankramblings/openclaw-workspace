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

  var FONT_STACK = '"MonoLisa", ui-monospace, monospace';

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
