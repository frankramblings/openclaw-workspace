// Extracted from login.html so the page is clean under the enforced CSP
// (script-src 'self'): no inline <script>, no nonce placeholder.
// Loaded render-blocking in <head> on purpose: it sets theme CSS vars and the
// body background-pattern class before first paint, so deferring it would
// reintroduce a flash of the default palette.
(function(){
  // Per-theme bg-effect defaults — mirrors THEME_DEFAULT_* maps in
  // static/js/theme.js so login picks the same default pattern as the
  // main app for users who never explicitly chose one.
  var THEME_DEFAULT_PATTERN = {
    dark:'none', light:'dots', midnight:'rain', paper:'dots',
    cyberpunk:'synapse', retrowave:'embers', forest:'petals',
    ocean:'constellations', terminal:'perlin-flow', organs:'rain',
    ume:'petals', cute:'sparkles'
  };
  var THEME_DEFAULT_EFFECT_COLOR = {
    midnight:'#ffffff', organs:'#451616', cute:'#ff8cb8', ume:'#f5a0c0'
  };
  var THEME_DEFAULT_INTENSITY = { midnight:0.5, terminal:0.8, organs:0.65 };
  try {
    var t = JSON.parse(localStorage.getItem('odysseus-theme'));
    var s = document.documentElement.style;
    if (t && t.colors) {
      var c = t.colors;
      // Base palette
      s.setProperty('--bg', c.bg);
      s.setProperty('--fg', c.fg);
      s.setProperty('--panel', c.panel);
      s.setProperty('--border', c.border);
      if (c.red) s.setProperty('--red', c.red);
      if (c.green) s.setProperty('--green', c.green);
      // Advanced overrides (sidebar logo color, input bg, send-button bg, etc.)
      // — mirrors ADV_KEYS in static/js/theme.js so the login page picks up
      // every customization the user has on their theme instead of falling
      // back to defaults that didn't match the main app.
      var a = c.advanced || {};
      var ADV = {
        userBubbleBg:    '--user-bubble-bg',
        aiBubbleBg:      '--ai-bubble-bg',
        bubbleBorder:    '--bubble-border',
        sidebarBg:       '--sidebar-bg',
        brandColor:      '--brand-color',
        hamburgerColor:  '--hamburger-color',
        inputBg:         '--input-bg',
        inputBorder:     '--input-border',
        sendBtnBg:       '--send-btn-bg',
        sendBtnHover:    '--send-btn-hover',
        codeBg:          '--code-bg',
        codeFg:          '--code-fg',
        toggleActive:    '--toggle-active',
      };
      for (var k in ADV) { if (a[k]) s.setProperty(ADV[k], a[k]); }
    }
    // Background effect — pick ONE at random from the main app's 8
    // patterns each load (matches the old login behavior, but uses the
    // same effect implementations the main theme system exposes so the
    // login feels consistent with the rest of the app). Per-theme
    // bgEffectColor/Intensity defaults still apply so the random
    // pattern picks up theme-appropriate tinting.
    var name = (t && t.name) || '';
    // perlin-flow excluded — too visually intense for a login screen.
    var PATTERNS = ['dots','synapse','rain','constellations','petals','sparkles','embers'];
    var pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)];
    var effColor = (t && t.bgEffectColor) || THEME_DEFAULT_EFFECT_COLOR[name] || '';
    var effInt = (t && t.bgEffectIntensity !== undefined)
      ? t.bgEffectIntensity
      : (THEME_DEFAULT_INTENSITY[name] !== undefined ? THEME_DEFAULT_INTENSITY[name] : 1);
    var effSize = (t && t.bgEffectSize !== undefined) ? t.bgEffectSize : 1;
    if (effColor) s.setProperty('--bg-effect-color', effColor);
    s.setProperty('--bg-effect-intensity', String(effInt));
    s.setProperty('--bg-effect-size', String(effSize));
    // Stash so the deferred module knows which canvas effect to start.
    window.__loginBgPattern = pattern;
    // Apply the body class as soon as <body> exists so static-gradient
    // patterns (dots, synapse) paint immediately on first frame.
    var apply = function() { document.body.classList.add('bg-pattern-' + pattern); };
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  } catch(e){}
})();
