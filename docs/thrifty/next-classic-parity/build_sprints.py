#!/usr/bin/env python3
"""Build sprints.jsonl for the next-classic-parity dispatch run."""
import json, pathlib

ROOT = pathlib.Path('/home/frank/openclaw-workspace')
SCRATCH = pathlib.Path(__file__).parent

icons_src = (ROOT / 'frontend-overrides/js/redesign/icons.js').read_text()
fx_src = (SCRATCH / 'constellations.js').read_text()
accent_src = '\n'.join((ROOT / 'frontend-overrides/js/redesign/live/settings.js').read_text().splitlines()[34:48])

theme_brief = f"""Write frontend-next/src/lib/theme.ts exactly per the contract's SPRINT-THEME section (interfaces, constants, applyTheme, normalizeThemePref, applyAccent, initTheme — all behaviors as specified there).

Classic source of applyAccent (port faithfully, .10 alpha, x0.58 ramp):
```js
{accent_src}
```
Notes: use document.documentElement.style.setProperty; meta theme-color lives in document.head (create if missing); localStorage access always inside try/catch; initTheme uses Promise.allSettled-style independence for the two fetches and resolves void. Dynamic import for constellations must keep the loaded module in a module-level variable so a later non-constellations applyTheme can call stopConstellations() without re-importing. No React, no other imports."""

theme_test_brief = """Write frontend-next/src/lib/theme.test.ts — vitest (jsdom) tests for src/lib/theme.ts via its exported API only (import { applyTheme, applyAccent, initTheme, normalizeThemePref, THEME_CACHE_KEY, CLASSIC_THEME_KEY, ACCENT_KEY } from './theme'). Start the file with: vi.mock('./constellations', () => ({ startConstellations: vi.fn(), stopConstellations: vi.fn() })). beforeEach: clear localStorage, remove inline styles via document.documentElement.removeAttribute('style'), document.body.className = ''. Read vars with document.documentElement.style.getPropertyValue.

Required cases (exact expected values):
1. applyTheme with the fortress pref (colors bg #07131f, fg #e7eef8, panel #0e2748, border #3b6d96, red #56c8ff, frosted true, bgEffectColor #9cdef2, bgEffectIntensity 1, bgEffectSize 1) sets --bg #07131f, --fg #e7eef8, --panel #0e2748, --border #3b6d96, --red #56c8ff; meta[name=theme-color] content #07131f; body classList contains theme-frosted; --bg-effect-color #9cdef2; --bg-effect-intensity '1'; --bg-effect-size '1'.
2. applyTheme with colors lacking red leaves --red unset; frosted false/undefined removes theme-frosted class (set it first via a frosted pref).
3. applyTheme with bgPattern 'constellations' calls the mocked startConstellations (await new Promise(r => setTimeout(r, 0)) after the call so the dynamic import settles; import the mocked module at file top to assert on the vi.fn).
4. applyAccent('#4fe3d1') sets --accent #4fe3d1, --teal #4fe3d1, --red #4fe3d1, --teal2 #2e8479, --tealtint rgba(79,227,209,.10).
5. applyAccent('nope') and applyAccent('#12345') change nothing.
6. normalizeThemePref: server-shaped input {name, colors:{bg,fg,panel,border,red,bgPattern:'constellations',frosted:true}} returns colors intact with bgPattern/frosted hoisted; flat input {bg,fg,panel,border} treats itself as colors; null/'x'/{} return null.
7. initTheme with empty localStorage and stubbed fetch (vi.stubGlobal) where /api/prefs/theme resolves the contract's fortress payload and /api/config resolves {accent:'#4fe3d1'}: after await, --bg is #07131f, localStorage THEME_CACHE_KEY parses to the fortress value, ACCENT_KEY === '#4fe3d1', --accent #4fe3d1.
8. initTheme when ACCENT_KEY already holds '#ff0000': /api/config accent is NOT applied — --accent stays #ff0000 (applied from the cache step) and ACCENT_KEY still '#ff0000'.
9. initTheme when both fetches reject but CLASSIC_THEME_KEY holds a flat cached theme {bg:'#111111',fg:'#eeeeee',panel:'#222222',border:'#333333'}: resolves without throwing, --bg #111111, and nothing was written to THEME_CACHE_KEY.
Restore stubs afterEach (vi.unstubAllGlobals)."""

icons_brief = f"""Write frontend-next/src/kit/icons.tsx exactly per the contract's SPRINT-ICONS section: a faithful TSX port of the classic icons module below. Keep every SVG body string byte-for-byte verbatim. Build a PATHS record keyed by IconName holding per-icon {{body, size, sw, stroke?, fill?, vb?}} defaults exactly matching each classic helper's defaults (research/library take stroke 'currentColor' default; search default stroke 'var(--faint)', chevDownSm stroke 'var(--faint)', check stroke 'var(--teal)', folder stroke 'var(--teal)'; dots fill 'currentColor'; star sw 1.5 fill none; play is the special fill-only svg with no stroke attributes). Icon renders one <svg> with width/height = size prop ?? per-icon default, viewBox '0 0 24 24' (vb 24 everywhere), the stroke/fill/stroke-width/linecap/linejoin attributes the classic icon() emits, optional className, and dangerouslySetInnerHTML for the body. Fortress renders the fortress svg (class fl-svg, viewBox '0 0 48 48', width/height = size ?? 16, role img, aria-label Loading) with the FORTRESS_BODY verbatim.

Classic source (ground truth):
```js
{icons_src}
```"""

icons_test_brief = """Write frontend-next/src/kit/icons.test.tsx — vitest (jsdom) tests for src/kit/icons.tsx using @testing-library/react render (import { Icon, Fortress } from './icons'). Cases:
1. render(<Icon name="chat" />): container has exactly one svg, width and height '18', viewBox '0 0 24 24', stroke 'currentColor', fill 'none', stroke-width '1.7', and innerHTML contains 'M21 11.5a8.38'.
2. render(<Icon name="chat" size={24} />): width/height '24'.
3. Per-icon defaults honored: check (width 26, stroke 'var(--teal)', stroke-width '2.2'), search (width 14, stroke 'var(--faint)', stroke-width '2'), dots (fill 'currentColor'), send (width 17, stroke-width '2.2').
4. play: svg has fill 'currentColor' and NO stroke attribute; contains 'M8 5v14l11-7z'.
5. className pass-through: <Icon name="x" className="foo" /> svg classList contains foo.
6. Fortress: default width/height '16', viewBox '0 0 48 48', class contains fl-svg, role 'img', aria-label 'Loading', innerHTML contains 'fl-crystal fl-c1' and 'fl-shard fl-s3'.
7. Every IconName renders: loop over ['chat','inbox','email','calendar','research','library','notes','settings','chevLeft','chevRight','chevDown','chevDownSm','search','plus','send','x','copy','download','branch','edit','star','dots','pencil','archive','trash','check','reply','file','folder','terminal','split','panelHide','panelShow','play','code','refresh','clock'] rendering <Icon name={n} /> yields an svg with non-empty innerHTML."""

fx_brief = f"""Write frontend-next/src/lib/constellations.ts exactly per the contract's SPRINT-FX section: a faithful TypeScript port of the classic constellations background effect below. Exports startConstellations()/stopConstellations() only. Module-level state: canvas, 2d ctx, rAF id, resize handler, running flag. startConstellations: no-op if already running or if document.getElementById('constellations-canvas') exists; create the canvas with the same id and style.cssText, prepend to document.body, and if getContext('2d') is null remove the canvas and bail. Keep the drawing math, star field sizing, link distance, colors, alpha handling, and var reads (--bg-effect-color, --bg-effect-intensity, --bg-effect-size, fallback behavior) semantically identical to the source. stopConstellations: cancelAnimationFrame, removeEventListener, remove the canvas, reset state; safe to call when not running. Type everything (no any); the noise helpers may be omitted if the constellations path never calls them — port ONLY what constellations uses.

Classic source (ground truth):
```js
{fx_src}
```"""

sprints = [
    {"id": "SPRINT-THEME", "tier": "haiku", "kind": "generate", "deps": [], "brief": theme_brief},
    {"id": "SPRINT-FX", "tier": "haiku", "kind": "generate", "deps": [], "brief": fx_brief},
    {"id": "SPRINT-ICONS", "tier": "haiku", "kind": "generate", "deps": [], "brief": icons_brief},
    {"id": "SPRINT-THEME-TEST", "tier": "haiku", "kind": "generate", "deps": ["SPRINT-THEME"], "brief": theme_test_brief},
    {"id": "SPRINT-ICONS-TEST", "tier": "haiku", "kind": "generate", "deps": ["SPRINT-ICONS"], "brief": icons_test_brief},
]

out = ROOT / 'sprints.jsonl'
out.write_text('\n'.join(json.dumps(s) for s in sprints) + '\n')
print(f"wrote {out} ({len(sprints)} sprints, {sum(len(s['brief']) for s in sprints)} brief chars)")
