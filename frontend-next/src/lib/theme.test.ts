import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyTheme,
  applyAccent,
  initTheme,
  normalizeThemePref,
  THEME_CACHE_KEY,
  CLASSIC_THEME_KEY,
  ACCENT_KEY
} from './theme';

vi.mock('./constellations', () => ({
  startConstellations: vi.fn(),
  stopConstellations: vi.fn()
}));

import { startConstellations } from './constellations';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
    document.body.className = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('case 1: applyTheme with fortress pref sets all CSS vars and meta', () => {
    const fortressPref = {
      name: 'fortress',
      colors: {
        bg: '#07131f',
        fg: '#e7eef8',
        panel: '#0e2748',
        border: '#3b6d96',
        red: '#56c8ff'
      },
      frosted: true,
      bgEffectColor: '#9cdef2',
      bgEffectIntensity: 1,
      bgEffectSize: 1
    };

    applyTheme(fortressPref);

    expect(document.documentElement.style.getPropertyValue('--bg').trim()).toBe('#07131f');
    expect(document.documentElement.style.getPropertyValue('--fg').trim()).toBe('#e7eef8');
    expect(document.documentElement.style.getPropertyValue('--panel').trim()).toBe('#0e2748');
    expect(document.documentElement.style.getPropertyValue('--border').trim()).toBe('#3b6d96');
    expect(document.documentElement.style.getPropertyValue('--red').trim()).toBe('#56c8ff');

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    expect(themeColorMeta?.getAttribute('content')).toBe('#07131f');

    expect(document.body.classList.contains('theme-frosted')).toBe(true);

    expect(document.documentElement.style.getPropertyValue('--bg-effect-color').trim()).toBe('#9cdef2');
    expect(document.documentElement.style.getPropertyValue('--bg-effect-intensity').trim()).toBe('1');
    expect(document.documentElement.style.getPropertyValue('--bg-effect-size').trim()).toBe('1');
  });

  it('case 2: applyTheme without red leaves --red unset; frosted false removes class', () => {
    applyTheme({
      colors: { bg: '#111111', fg: '#eeeeee', panel: '#222222', border: '#333333' },
      frosted: true
    });
    expect(document.body.classList.contains('theme-frosted')).toBe(true);

    applyTheme({
      colors: { bg: '#111111', fg: '#eeeeee', panel: '#222222', border: '#333333' },
      frosted: false
    });

    expect(document.documentElement.style.getPropertyValue('--red')).toBe('');
    expect(document.body.classList.contains('theme-frosted')).toBe(false);
  });

  it('case 3: applyTheme with bgPattern constellations calls startConstellations', async () => {
    const pref = {
      colors: { bg: '#000000', fg: '#ffffff', panel: '#111111', border: '#222222' },
      bgPattern: 'constellations'
    };

    applyTheme(pref);
    await new Promise(r => setTimeout(r, 0));

    expect(startConstellations).toHaveBeenCalled();
  });

  it('case 4: applyAccent with valid hex sets all accent vars', () => {
    applyAccent('#4fe3d1');

    expect(document.documentElement.style.getPropertyValue('--accent').trim()).toBe('#4fe3d1');
    expect(document.documentElement.style.getPropertyValue('--teal').trim()).toBe('#4fe3d1');
    expect(document.documentElement.style.getPropertyValue('--red').trim()).toBe('#4fe3d1');
    expect(document.documentElement.style.getPropertyValue('--teal2').trim()).toBe('#2e8479');
    expect(document.documentElement.style.getPropertyValue('--tealtint').trim()).toBe('rgba(79,227,209,.10)');
  });

  it('case 5: applyAccent with invalid input does nothing', () => {
    applyAccent('nope');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');

    applyAccent('#12345');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });

  it('case 6: normalizeThemePref handles server and flat shapes', () => {
    const serverShaped = normalizeThemePref({
      name: 'fortress',
      colors: {
        bg: '#07131f',
        fg: '#e7eef8',
        panel: '#0e2748',
        border: '#3b6d96',
        red: '#56c8ff',
        bgPattern: 'constellations',
        frosted: true
      }
    });

    expect(serverShaped?.name).toBe('fortress');
    expect(serverShaped?.colors?.bg).toBe('#07131f');
    expect(serverShaped?.colors?.fg).toBe('#e7eef8');
    expect(serverShaped?.colors?.panel).toBe('#0e2748');
    expect(serverShaped?.colors?.border).toBe('#3b6d96');
    expect(serverShaped?.colors?.red).toBe('#56c8ff');
    expect(serverShaped?.bgPattern).toBe('constellations');
    expect(serverShaped?.frosted).toBe(true);

    const flat = normalizeThemePref({
      bg: '#111111',
      fg: '#eeeeee',
      panel: '#222222',
      border: '#333333'
    });

    expect(flat?.colors?.bg).toBe('#111111');
    expect(flat?.colors?.fg).toBe('#eeeeee');
    expect(flat?.colors?.panel).toBe('#222222');
    expect(flat?.colors?.border).toBe('#333333');

    expect(normalizeThemePref(null)).toBe(null);
    expect(normalizeThemePref('x')).toBe(null);
    expect(normalizeThemePref({})).toBe(null);
  });

  it('case 7: initTheme fetches and caches theme and accent', async () => {
    const fortressValue = {
      name: 'fortress',
      colors: {
        bg: '#07131f',
        fg: '#e7eef8',
        panel: '#0e2748',
        border: '#3b6d96',
        red: '#56c8ff',
        advanced: {} as Record<string, unknown>,
        font: 'mono',
        density: 'comfortable',
        bgPattern: 'constellations',
        bgEffectColor: '#9cdef2',
        bgEffectIntensity: 1,
        bgEffectSize: 1,
        frosted: true
      }
    };

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/prefs/theme') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ key: 'theme', value: fortressValue })
        } as Response);
      }
      if (url === '/api/config') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent_name: 'Gary', accent: '#4fe3d1' })
        } as Response);
      }
      return Promise.reject(new Error('Unknown URL'));
    }));

    await initTheme();

    expect(document.documentElement.style.getPropertyValue('--bg').trim()).toBe('#07131f');
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe(JSON.stringify(fortressValue));
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#4fe3d1');
    expect(document.documentElement.style.getPropertyValue('--accent').trim()).toBe('#4fe3d1');
  });

  it('case 8: initTheme respects cached accent and ignores fetch', async () => {
    localStorage.setItem(ACCENT_KEY, '#ff0000');

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/prefs/theme') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            key: 'theme',
            value: {
              colors: { bg: '#000000', fg: '#ffffff', panel: '#111111', border: '#222222' }
            }
          })
        } as Response);
      }
      if (url === '/api/config') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent_name: 'Gary', accent: '#4fe3d1' })
        } as Response);
      }
      return Promise.reject(new Error('Unknown URL'));
    }));

    await initTheme();

    expect(document.documentElement.style.getPropertyValue('--accent').trim()).toBe('#ff0000');
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#ff0000');
  });

  it('case 9: initTheme fails soft on network errors, uses classic cache', async () => {
    const classicTheme = {
      bg: '#111111',
      fg: '#eeeeee',
      panel: '#222222',
      border: '#333333'
    };

    localStorage.setItem(CLASSIC_THEME_KEY, JSON.stringify(classicTheme));

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Network error'))));

    await initTheme();

    expect(document.documentElement.style.getPropertyValue('--bg').trim()).toBe('#111111');
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });
});
