import { useState } from 'react'
import { Card } from '../../kit'
import { Icon } from '../../kit/icons'
import {
  ACCENT_KEY, THEME_PRESETS, currentTheme, persistAccent, saveTheme,
  type ThemeColors,
} from '../../lib/theme'

// Classic redesign's accent swatch set (surfaces.js 'accent' row).
const SWATCHES = ['#4fe3d1', '#7bb6ff', '#5bd97f', '#a99bf5', '#f0726a', '#e8c268', '#f97ab8', '#67c4e3', '#ff9850', '#c6e847']

const CHARCOAL: ThemeColors = { bg: '#15161a', fg: '#dfe2e8', panel: '#1b1c21', border: '#2d2f36', red: '#f0726a' }
const FIELDS: Array<{ key: keyof ThemeColors; label: string }> = [
  { key: 'bg', label: 'Background' },
  { key: 'fg', label: 'Text' },
  { key: 'panel', label: 'Panel' },
  { key: 'border', label: 'Border' },
  { key: 'red', label: 'Highlight' },
]

function storedAccent(): string {
  try { return localStorage.getItem(ACCENT_KEY) || '#4fe3d1' } catch { return '#4fe3d1' }
}

export function AppearanceCard() {
  const saved = currentTheme()
  const [name, setName] = useState(saved?.name ?? '')
  const [colors, setColors] = useState<ThemeColors>({ ...CHARCOAL, ...saved?.colors })
  const [accent, setAccent] = useState(storedAccent)

  const applyColors = (next: ThemeColors, nextName: string) => {
    setColors(next)
    setName(nextName)
    saveTheme(nextName, next)
  }
  const pickAccent = (hex: string) => {
    setAccent(hex)
    persistAccent(hex)
  }
  const customAccent = !SWATCHES.includes(accent)

  return (
    <Card title="Appearance">
      <div className="next-appearance">
        <label className="next-appearance-preset">
          Theme
          <select
            aria-label="Theme preset"
            value={THEME_PRESETS[name] ? name : 'custom'}
            onChange={(event) => {
              const preset = THEME_PRESETS[event.target.value]
              if (preset) applyColors({ ...preset }, event.target.value)
            }}
          >
            <option value="custom" disabled>{name && !THEME_PRESETS[name] ? `${name} (current)` : 'Custom'}</option>
            {Object.keys(THEME_PRESETS).map((preset) => <option key={preset} value={preset}>{preset}</option>)}
          </select>
        </label>
        <div className="next-appearance-colors">
          {FIELDS.map(({ key, label }) => (
            <label key={key}>
              {label}
              <input
                type="color"
                aria-label={`${label} color`}
                value={colors[key] || CHARCOAL[key] || '#000000'}
                onInput={(event) => applyColors({ ...colors, [key]: (event.target as HTMLInputElement).value }, 'custom')}
              />
            </label>
          ))}
        </div>
        <p className="next-appearance-label">Accent</p>
        <div className="set-accents">
          {SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              className="set-accent"
              aria-label={`Accent ${hex}`}
              style={{ background: hex, boxShadow: accent === hex ? `0 0 0 3px ${hex}55` : undefined }}
              onClick={() => pickAccent(hex)}
            >
              {accent === hex && <Icon name="check" size={17} className="next-appearance-check" />}
            </button>
          ))}
          <label className={`set-accent-custom${customAccent ? ' on' : ''}`} title="Custom accent">
            <input
              type="color"
              aria-label="Custom accent color"
              value={customAccent ? accent : '#4fe3d1'}
              onInput={(event) => pickAccent((event.target as HTMLInputElement).value)}
            />
            <span>{customAccent ? '✓' : '+'}</span>
          </label>
        </div>
        <small>Applies immediately here and to the classic app on this device; new devices pick it up from the server.</small>
      </div>
    </Card>
  )
}
