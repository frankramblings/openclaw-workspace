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

export function applyTheme(pref: ThemePref): void {
  const s = document.documentElement.style

  if (pref.colors) {
    s.setProperty('--bg', pref.colors.bg)
    s.setProperty('--fg', pref.colors.fg)
    s.setProperty('--panel', pref.colors.panel)
    s.setProperty('--border', pref.colors.border)
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

export async function initTheme(): Promise<void> {
  try {
    let cached = localStorage.getItem(THEME_CACHE_KEY)
    if (!cached) {
      cached = localStorage.getItem(CLASSIC_THEME_KEY)
    }
    if (cached) {
      const pref = normalizeThemePref(JSON.parse(cached))
      if (pref) {
        applyTheme(pref)
      }
    }
  } catch (e) {}

  try {
    const cachedAccent = localStorage.getItem(ACCENT_KEY)
    if (cachedAccent) {
      applyAccent(cachedAccent)
    }
  } catch (e) {}

  const themePromise = (async () => {
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
