# Contract — /next classic visual parity, dispatch tier (mechanical ports)

Repo: OpenClaw workspace. Target app: `frontend-next/` — React 18 + TypeScript (strict) + Vite, vitest (jsdom, imports `test/expect/vi` explicitly from 'vitest'), @testing-library/react v16. JSX runtime is automatic (`react-jsx`): never `import React`. No new dependencies. All files you write live under `frontend-next/src/`.

These sprints port classic-UI runtime behavior into /next as NEW self-contained files. Each sprint writes EXACTLY ONE file (the path named in its brief). Source excerpts pasted in briefs are ground truth — replicate behavior exactly; do not "improve" visual/behavioral semantics. Code style: lean, typed, no comments restating code; brief file-top comment stating role.

## Shared API (cross-file seam — every signature here is FROZEN)

### `frontend-next/src/lib/theme.ts` (SPRINT-THEME)
```ts
export interface ThemeColors { bg: string; fg: string; panel: string; border: string; red?: string }
export interface ThemePref {
  name?: string
  colors?: ThemeColors
  bgPattern?: string
  bgEffectColor?: string
  bgEffectIntensity?: number
  bgEffectSize?: number
  frosted?: boolean
}
export const THEME_CACHE_KEY = 'next-theme-cache'   // /next's own cache; written by initTheme
export const CLASSIC_THEME_KEY = 'odysseus-theme'   // classic UI's cache; READ-ONLY, never write
export const ACCENT_KEY = 'oc-accent'               // shared with classic; write ONLY when absent
export function normalizeThemePref(raw: unknown): ThemePref | null
export function applyTheme(pref: ThemePref): void
export function applyAccent(hex: string): void
export function initTheme(): Promise<void>
```
Behavior:
- `applyTheme`: on `document.documentElement.style`, set `--bg --fg --panel --border` from `pref.colors` (skip all four if colors missing; set `--red` only if `colors.red`). Update/create `<meta name="theme-color">` = colors.bg. Toggle class `theme-frosted` on `<body>` per `!!pref.frosted`. Set `--bg-effect-color` (remove the property when falsy), `--bg-effect-intensity` and `--bg-effect-size` (String(n), default '1' when undefined). If `pref.bgPattern === 'constellations'`, lazily `import('./constellations')` and call `startConstellations()`; for any other value call `stopConstellations()` IF the module was already loaded (never load it just to stop). Never throws.
- `normalizeThemePref`: accepts the server pref `value` or a cached object; input may be `{name, colors: {bg,fg,panel,border,red, advanced?, font?, bgPattern?, frosted?, ...}, bgPattern?, bgEffectColor?, ...}` (colors bag may carry extra keys — ignore them) OR a flat `{bg, fg, panel, border, ...}` legacy shape (treat the object itself as colors when it has all of bg/fg/panel/border). Effect/pattern/frosted fields: prefer the value inside `colors`, fall back to the top level. Returns null for non-objects / no usable content.
- `applyAccent(hex)`: guard `/^#[0-9a-fA-F]{6}$/` (silent no-op otherwise). Port of classic `setAccentVars` pasted in the brief: sets `--accent --red --teal` = hex, `--teal2` = each channel ×0.58 (Math.round, 2-digit hex), `--tealtint` = `rgba(r,g,b,.10)`.
- `initTheme()`: (1) synchronously apply cached theme: parse localStorage `THEME_CACHE_KEY`, else `CLASSIC_THEME_KEY`, via normalizeThemePref → applyTheme. (2) synchronously apply cached accent from `ACCENT_KEY` if present. (3) `fetch('/api/prefs/theme')` → json `{key, value}` → normalize → applyTheme + write JSON.stringify(value) to `THEME_CACHE_KEY`. (4) `fetch('/api/config')` → `{accent}` → ONLY if `ACCENT_KEY` was absent from localStorage: applyAccent + store hex in `ACCENT_KEY` (classic's seed-once semantics — a stored accent is a user override classic owns). (3)+(4) run concurrently; every step fail-soft (bad JSON, non-OK status, network reject, localStorage throwing) — initTheme never rejects.

### `frontend-next/src/lib/constellations.ts` (SPRINT-FX)
```ts
export function startConstellations(): void   // idempotent; no-op if already running
export function stopConstellations(): void    // cancels rAF, removes canvas + resize listener; safe when not running
```
Faithful TS port of the classic canvas effect pasted in the brief (same canvas id, geometry, drawing math). Additional hard requirements: bail cleanly if `canvas.getContext('2d')` returns null (jsdom); keep handles module-level so stop() fully reverses start().

### `frontend-next/src/kit/icons.tsx` (SPRINT-ICONS)
```ts
export type IconName = /* every key of the classic I map: chat, inbox, email, calendar, research, library, notes, settings, chevLeft, chevRight, chevDown, chevDownSm, search, plus, send, x, copy, download, branch, edit, star, dots, pencil, archive, trash, check, reply, file, folder, terminal, split, panelHide, panelShow, play, code, refresh, clock */
export interface IconProps { name: IconName; size?: number; className?: string }
export function Icon(props: IconProps): JSX.Element
export function Fortress({ size }: { size?: number }): JSX.Element   // default 16
```
Port of classic `icons.js` pasted in the brief. Keep every SVG body string VERBATIM (including per-icon default size, stroke-width, stroke color like 'var(--faint)', fill behavior, star's filled variant is NOT ported — plain outline). Render via `<svg {...attrs} dangerouslySetInnerHTML={{ __html: body }} />` from a single `PATHS` record of `{ body, size, sw, stroke?, fill?, vb? }`; `play` keeps its special fill-only form (no stroke attrs). `size` prop overrides the per-icon default. Fortress reproduces `fortress(size)` exactly (class `fl-svg`, viewBox 48, role img, aria-label Loading).

### Tests
- `frontend-next/src/lib/theme.test.ts` (SPRINT-THEME-TEST) — tests theme.ts strictly through the exported API above.
- `frontend-next/src/kit/icons.test.tsx` (SPRINT-ICONS-TEST) — tests icons.tsx through its exported API.
Mock network with `vi.stubGlobal('fetch', ...)`; mock the constellations module with `vi.mock('./constellations', () => ({ startConstellations: vi.fn(), stopConstellations: vi.fn() }))`. Reset DOM/localStorage between tests. Follow repo convention: explicit vitest imports, @testing-library/react `render`.

## Endpoint ground truth (mock these shapes in tests)
- `GET /api/prefs/theme` → `{"key":"theme","value":{"name":"fortress","colors":{"bg":"#07131f","fg":"#e7eef8","panel":"#0e2748","border":"#3b6d96","red":"#56c8ff","advanced":{...},"font":"mono","density":"comfortable","bgPattern":"constellations","bgEffectColor":"#9cdef2","bgEffectIntensity":1,"bgEffectSize":1,"frosted":true},"font":"mono","bgPattern":"constellations","bgEffectColor":"#9cdef2"}}`
- `GET /api/config` → `{"agent_name":"Gary","accent":"#4fe3d1", ...}`

## Dependency graph
SPRINT-THEME ← SPRINT-THEME-TEST; SPRINT-ICONS ← SPRINT-ICONS-TEST; SPRINT-FX independent (theme.ts only touches it via dynamic import of the frozen API).

## Gate (run by the orchestrator, not you)
`cd frontend-next && npm run build` (tsc --noEmit + vite build) and `npx vitest run src/lib/theme.test.ts src/kit/icons.test.tsx`.
