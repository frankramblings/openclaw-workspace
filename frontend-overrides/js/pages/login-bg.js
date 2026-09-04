// Extracted from login.html so the page is clean under the enforced CSP
// (script-src 'self'): no inline <script>, no nonce placeholder.
// Drive the login page's bg effect off the user's saved theme. The
// sync bootstrap in login-theme-boot.js already set the body class + effect CSS vars so
// the static-gradient patterns (dots, synapse) paint immediately; this
// block imports theme.js's canvas implementations for the dynamic
// patterns (rain, constellations, perlin-flow, petals, sparkles,
// embers, synapse pulses).
//
// IMPORTANT: theme.js's auto-init (`_initWithSync` → `initThemeUI`)
// early-returns at `#themeGrid` which doesn't exist on this page, so
// `applyBgPattern` would never fire on its own. We call it directly
// here against the pattern the bootstrap already chose.
try {
  const tm = await import('../theme.js');
  const pattern = window.__loginBgPattern;
  if (pattern && tm.applyBgPattern) tm.applyBgPattern(pattern);
} catch (e) {
  console.error('[login-bg] failed:', e);
}
