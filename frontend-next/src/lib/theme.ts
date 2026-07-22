// Theme configuration and initialization for /next
export interface ThemeColors {
  bg: string
  fg: string
  panel: string
  border: string
  red?: string
}

export interface ThemePref {
  name?: string
  colors?: ThemeColors
  bgPattern?: string
  bgEffectColor?: string
  bgEffectIntensity?: number
  bgEffectSize?: number
  frosted?: boolean
}

export const THEME_CACHE_KEY = 'next-theme-cache'
export const CLASSIC_THEME_KEY = 'odysseus-theme'
export const ACCENT_KEY = 'oc-accent'

let constellationsModule: any = null

export function normalizeThemePref(raw: unknown): ThemePref | null {
  if (typeof raw !== 'object' || raw === null) return null

  const obj = raw as Record<string, any>

  const isFlatColors =
    obj.bg &&
    obj.fg &&
    obj.panel &&
    obj.border &&
    typeof obj.bg === 'string' &&
    typeof obj.fg === 'string' &&
    typeof obj.panel === 'string' &&
    typeof obj.border === 'string'

  if (isFlatColors && !obj.colors) {
    return {
      name: obj.name,
      colors: {
        bg: obj.bg,
        fg: obj.fg,
        panel: obj.panel,
        border: obj.border,
        red: obj.red
      },
      bgPattern: obj.bgPattern,
      bgEffectColor: obj.bgEffectColor,
      bgEffectIntensity: obj.bgEffectIntensity,
      bgEffectSize: obj.bgEffectSize,
      frosted: obj.frosted
    }
  }

  if (obj.colors && typeof obj.colors === 'object') {
    const colors = obj.colors as Record<string, any>
    if (
      !(
        colors.bg &&
        colors.fg &&
        colors.panel &&
        colors.border &&
        typeof colors.bg === 'string' &&
        typeof colors.fg === 'string' &&
        typeof colors.panel === 'string' &&
        typeof colors.border === 'string'
      )
    ) {
      return null
    }

    return {
      name: obj.name,
      colors: {
        bg: colors.bg,
        fg: colors.fg,
        panel: colors.panel,
        border: colors.border,
        red: colors.red
      },
      bgPattern: obj.bgPattern ?? colors.bgPattern,
      bgEffectColor: obj.bgEffectColor ?? colors.bgEffectColor,
      bgEffectIntensity: obj.bgEffectIntensity ?? colors.bgEffectIntensity,
      bgEffectSize: obj.bgEffectSize ?? colors.bgEffectSize,
      frosted: obj.frosted ?? colors.frosted
    }
  }

  return null
}

/** Channel-wise blend of two hex colors; weight = share of `a`. */
export function mix(a: string, b: string, weight: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16)
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  const blend = (i: number) => toHex(ch(a, i) * weight + ch(b, i) * (1 - weight))
  return `#${blend(1)}${blend(3)}${blend(5)}`
}

// Secondary tokens derived from the theme's own fg/bg/panel so muted text,
// hairlines, and hovers keep their contrast RATIO on any theme. Weights are
// tuned to reproduce the Refined Charcoal defaults from the charcoal theme
// (e.g. mix(fg,bg,.12) → #2d2f33 vs the stylesheet's #2d2f36).
function applyDerivedTokens(s: CSSStyleDeclaration, colors: ThemeColors): void {
  const { bg, fg, panel } = colors
  const ok = /^#[0-9a-fA-F]{6}$/
  if (!ok.test(bg) || !ok.test(fg) || !ok.test(panel)) return
  s.setProperty('--mut', mix(fg, bg, 0.66))
  s.setProperty('--faint', mix(fg, bg, 0.44))
  s.setProperty('--bd', mix(fg, bg, 0.12))
  s.setProperty('--bd2', mix(fg, bg, 0.08))
  s.setProperty('--panel2', mix(fg, panel, 0.05))
  s.setProperty('--elev', mix(fg, panel, 0.07))
  s.setProperty('--row-hover', mix(fg, bg, 0.05))
  s.setProperty('--chrome', mix(bg, '#000000', 0.8))
}

export function applyTheme(pref: ThemePref): void {
  const s = document.documentElement.style

  if (pref.colors) {
    s.setProperty('--bg', pref.colors.bg)
    s.setProperty('--fg', pref.colors.fg)
    s.setProperty('--panel', pref.colors.panel)
    s.setProperty('--border', pref.colors.border)
    applyDerivedTokens(s, pref.colors)
    if (pref.colors.red) {
      s.setProperty('--red', pref.colors.red)
    }

    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', pref.colors.bg)
    } else {
      const meta = document.createElement('meta')
      meta.name = 'theme-color'
      meta.content = pref.colors.bg
      document.head.appendChild(meta)
    }
  }

  if (pref.frosted) {
    document.body.classList.add('theme-frosted')
  } else {
    document.body.classList.remove('theme-frosted')
  }

  if (pref.bgEffectColor) {
    s.setProperty('--bg-effect-color', pref.bgEffectColor)
  } else {
    s.removeProperty('--bg-effect-color')
  }

  s.setProperty('--bg-effect-intensity', String(pref.bgEffectIntensity ?? 1))
  s.setProperty('--bg-effect-size', String(pref.bgEffectSize ?? 1))

  if (pref.bgPattern === 'constellations') {
    import('./constellations')
      .then(mod => {
        constellationsModule = mod
        mod.startConstellations()
      })
      .catch(() => {})
  } else {
    if (constellationsModule) {
      constellationsModule.stopConstellations()
    }
  }
}

export function applyAccent(hex: string): void {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return

  const s = document.documentElement.style
  s.setProperty('--accent', hex)
  s.setProperty('--red', hex)

  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)

  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0')

  s.setProperty('--teal', hex)
  s.setProperty('--teal2', `#${toHex(r * 0.58)}${toHex(g * 0.58)}${toHex(b * 0.58)}`)
  s.setProperty('--tealtint', `rgba(${r},${g},${b},.10)`)
}

/** Classic core presets (5-color subset of theme.js THEMES) for the editor. */
export const THEME_PRESETS: Record<string, ThemeColors> = {
  dark: { bg: '#282c34', fg: '#9cdef2', panel: '#111111', border: '#355a66', red: '#e06c75' },
  light: { bg: '#f0ebe3', fg: '#5a5248', panel: '#faf6f0', border: '#d4cdc2', red: '#c47d5a' },
  midnight: { bg: '#0d1117', fg: '#c9d1d9', panel: '#161b22', border: '#30363d', red: '#f85149' },
  paper: { bg: '#faf8f5', fg: '#3b3836', panel: '#ffffff', border: '#d5d0c8', red: '#c5ac4a' },
  ocean: { bg: '#0b1a2c', fg: '#64d2ff', panel: '#091422', border: '#1e5074', red: '#4facfe' },
  forest: { bg: '#1b2a1b', fg: '#a8d5a2', panel: '#142414', border: '#3d6b3d', red: '#7cb871' },
  copper: { bg: '#1c1410', fg: '#e8c39e', panel: '#140f0a', border: '#7a5533', red: '#d4764e' },
  terminal: { bg: '#000000', fg: '#00ff41', panel: '#0a0a0a', border: '#003b00', red: '#00ff41' },
  gpt: { bg: '#212121', fg: '#ececec', panel: '#171717', border: '#424242', red: '#949494' },
  claude: { bg: '#262624', fg: '#f5f4f0', panel: '#30302e', border: '#4a4a47', red: '#c6613f' },
  hermesCharcoal: { bg: '#1e1f22', fg: '#d7dae0', panel: '#17181b', border: '#33353a', red: '#e8c268' },
  hermesNavy: { bg: '#10141f', fg: '#e8eaf2', panel: '#141a2a', border: '#27304a', red: '#ffd700' },
}

/** The theme the editor should start from: the device's saved pref. */
export function currentTheme(): ThemePref | null {
  try {
    const cached = localStorage.getItem(CLASSIC_THEME_KEY) ?? localStorage.getItem(THEME_CACHE_KEY)
    return cached ? normalizeThemePref(JSON.parse(cached)) : null
  } catch (e) {
    return null
  }
}

/** Apply + persist a theme edit the way classic's save() does: the device's
 *  odysseus-theme LS (which / reads at boot) plus the server pref (which seeds
 *  fresh devices). Non-color fields of the existing pref (bgPattern, effects,
 *  frosted) are preserved. */
export function saveTheme(name: string, colors: ThemeColors): void {
  const existing = currentTheme()
  const pref: ThemePref = { ...existing, name, colors }
  applyTheme(pref)
  const stored = {
    name,
    colors,
    ...(pref.bgPattern ? { bgPattern: pref.bgPattern } : {}),
    ...(pref.bgEffectColor ? { bgEffectColor: pref.bgEffectColor } : {}),
    ...(pref.bgEffectIntensity !== undefined && pref.bgEffectIntensity !== 1 ? { bgEffectIntensity: pref.bgEffectIntensity } : {}),
    ...(pref.bgEffectSize !== undefined && pref.bgEffectSize !== 1 ? { bgEffectSize: pref.bgEffectSize } : {}),
    ...(pref.frosted ? { frosted: true } : {}),
  }
  try { localStorage.setItem(CLASSIC_THEME_KEY, JSON.stringify(stored)) } catch (e) {}
  try { localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(stored)) } catch (e) {}
  fetch('/api/prefs/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ value: stored }),
  }).catch(() => {})
}

/** Apply + persist an accent the way classic's settings do (oc-accent LS,
 *  prefs store, settings bag — all best-effort). */
export function persistAccent(hex: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return
  applyAccent(hex)
  try { localStorage.setItem(ACCENT_KEY, hex) } catch (e) {}
  void Promise.allSettled([
    fetch('/api/prefs/accent', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ value: hex }) }),
    fetch('/api/auth/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ accent: hex }) }),
  ])
}

export async function initTheme(): Promise<void> {
  // Classic-exact precedence (theme.js _initWithSync): the DEVICE's theme wins
  // — classic LS first (what the user actually sees at /), then /next's own
  // mirror for classic-never-ran devices. The server pref is a seed for blank
  // devices only; it must never override a local choice.
  let haveDeviceTheme = false
  try {
    const cached = localStorage.getItem(CLASSIC_THEME_KEY) ?? localStorage.getItem(THEME_CACHE_KEY)
    if (cached) {
      const pref = normalizeThemePref(JSON.parse(cached))
      if (pref) {
        applyTheme(pref)
        haveDeviceTheme = true
      }
    }
  } catch (e) {}

  try {
    const cachedAccent = localStorage.getItem(ACCENT_KEY)
    if (cachedAccent) {
      applyAccent(cachedAccent)
    }
  } catch (e) {}

  const themePromise = haveDeviceTheme ? Promise.resolve() : (async () => {
    try {
      const response = await fetch('/api/prefs/theme')
      if (!response.ok) return
      const data = await response.json()
      const pref = normalizeThemePref(data.value)
      if (pref) {
        applyTheme(pref)
        try {
          localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(data.value))
        } catch (e) {}
      }
    } catch (e) {}
  })()

  const accentPromise = (async () => {
    try {
      let hasAccent = false
      try {
        hasAccent = !!localStorage.getItem(ACCENT_KEY)
      } catch (e) {}

      if (hasAccent) return

      const response = await fetch('/api/config')
      if (!response.ok) return
      const data = await response.json()
      if (data.accent) {
        applyAccent(data.accent)
        try {
          localStorage.setItem(ACCENT_KEY, data.accent)
        } catch (e) {}
      }
    } catch (e) {}
  })()

  await Promise.allSettled([themePromise, accentPromise])
}
