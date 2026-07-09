// Inline Lucide/Feather-style line icons for the redesign shell.
// Each helper returns an <svg> string. stroke=currentColor so color is inherited.

const A = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

/** Generic icon from a path body. */
export function icon(body, { size = 18, sw = 1.7, stroke = 'currentColor', fill = 'none', vb = 24 } = {}) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// The "fortress" loader — animated Kryptonian crystals (the brand loading
// spinner; named for Superman's Fortress of Solitude). Ported from the classic
// UI's fortress-loading-48.svg. Markup is namespaced (fl-* classes, NO inner
// <style> — the source asset's <style> has :root/.crystal rules that leak when
// inlined); the fl-grow/fl-shard keyframes live in redesign.css. Color is
// inherited via currentColor, so set `color` on the wrapper to tint it.
const FORTRESS_BODY = `
  <ellipse cx="24" cy="38.5" rx="15" ry="3.5" fill="currentColor" opacity=".14"/>
  <g stroke-linejoin="round">
    <path class="fl-crystal fl-c1" d="M23.6 38 L20.8 16 L24 6 L27.2 16 L24.4 38 Z" fill="currentColor" fill-opacity=".82" stroke="currentColor" stroke-opacity="1" stroke-width=".9"/>
    <path class="fl-crystal fl-c2" d="M17.5 38 L15.2 23 L18.4 12 L21.1 26 L20 38 Z" fill="currentColor" fill-opacity=".62" stroke="currentColor" stroke-opacity=".9" stroke-width=".8"/>
    <path class="fl-crystal fl-c3" d="M29 38 L27.4 25 L31.5 10 L34.4 24 L32.4 38 Z" fill="currentColor" fill-opacity=".62" stroke="currentColor" stroke-opacity=".9" stroke-width=".8"/>
    <path class="fl-crystal fl-c4" d="M12.7 39 L11.5 29 L14.6 20 L17 31 L16 39 Z" fill="currentColor" fill-opacity=".44" stroke="currentColor" stroke-opacity=".74" stroke-width=".75"/>
    <path class="fl-crystal fl-c5" d="M35.2 39 L33.7 30 L37.6 19 L40.1 31 L38.7 39 Z" fill="currentColor" fill-opacity=".44" stroke="currentColor" stroke-opacity=".74" stroke-width=".75"/>
    <path class="fl-crystal fl-c6" d="M20.3 39 L19.3 28 L22.1 19 L24.2 30 L23.2 39 Z" fill="currentColor" fill-opacity=".7" stroke="currentColor" stroke-opacity=".82" stroke-width=".65"/>
    <path class="fl-crystal fl-c7" d="M26.5 39 L25.8 29 L28.3 18 L30.7 30 L29.5 39 Z" fill="currentColor" fill-opacity=".7" stroke="currentColor" stroke-opacity=".82" stroke-width=".65"/>
  </g>
  <g fill="currentColor">
    <path class="fl-shard fl-s1" style="--dx:-8px;--dy:-12px" d="M15 18 l2 -3 l1 4 z"/>
    <path class="fl-shard fl-s2" style="--dx:9px;--dy:-15px" d="M32 16 l3 -2 l-1 4 z"/>
    <path class="fl-shard fl-s3" style="--dx:2px;--dy:-18px" d="M24 11 l2 -2 l1 3 z"/>
  </g>`;

/** Fortress crystals loader at a given pixel size. Returns an <svg> string. */
export function fortress(size = 16) {
  return `<svg class="fl-svg" viewBox="0 0 48 48" width="${size}" height="${size}" role="img" aria-label="Loading">${FORTRESS_BODY}</svg>`;
}

// ---- rail / surface icons -------------------------------------------------
export const I = {
  chat: (s = 18) => icon('<path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 8.5 8.5 0 0 1-3.8-.9L3 20l1.9-4.1A8.38 8.38 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/>', { size: s }),
  inbox: (s = 18) => icon('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.5z"/>', { size: s }),
  email: (s = 18) => icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', { size: s }),
  calendar: (s = 18) => icon('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>', { size: s }),
  research: (s = 17, stroke = 'currentColor') => icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>', { size: s, sw: 1.8, stroke }),
  library: (s = 17, stroke = 'currentColor') => icon('<path d="M4 5a2 2 0 0 1 2-2h11l3 3v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 8h7M8 12h7M8 16h4"/>', { size: s, sw: 1.8, stroke }),
  notes: (s = 17) => icon('<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>', { size: s }),
  settings: (s = 17) => icon('<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>', { size: s }),
  chevLeft: (s = 15) => icon('<path d="m15 6-6 6 6 6"/>', { size: s, sw: 1.8 }),
  chevRight: (s = 11) => icon('<path d="m9 18 6-6-6-6"/>', { size: s, sw: 2.4 }),
  chevDown: (s = 11) => icon('<path d="m6 9 6 6 6-6"/>', { size: s, sw: 2.4 }),
  chevDownSm: (s = 11) => icon('<polyline points="6 9 12 15 18 9"/>', { size: s, sw: 2.6, stroke: 'var(--faint)' }),
  search: (s = 14, stroke = 'var(--faint)') => icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>', { size: s, sw: 2, stroke }),
  plus: (s = 17) => icon('<path d="M12 5v14M5 12h14"/>', { size: s, sw: 2.2 }),
  send: (s = 17) => icon('<path d="M5 12h14M13 6l6 6-6 6"/>', { size: s, sw: 2.2 }),
  x: (s = 14) => icon('<path d="M18 6 6 18M6 6l12 12"/>', { size: s, sw: 1.8 }),
  copy: (s = 15) => icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', { size: s, sw: 1.8 }),
  download: (s = 15) => icon('<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>', { size: s, sw: 1.8 }),
  branch: (s = 15) => icon('<path d="M6 3v6M18 9a3 3 0 100 6 3 3 0 000-6zM6 3a3 3 0 100 6 3 3 0 000-6zM6 15v6M6 15a3 3 0 100 6 3 3 0 000-6zM18 15a6 6 0 01-6 6"/>', { size: s, sw: 1.8 }),
  edit: (s = 15) => icon('<path d="M4 20h4l10-10-4-4L4 16v4z M14 6l4 4"/>', { size: s, sw: 1.8 }),
  star: (s = 13, filled = false) => icon('<path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"/>', { size: s, sw: 1.5, fill: filled ? 'currentColor' : 'none' }),
  dots: (s = 15) => icon('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>', { size: s, sw: 1.6, fill: 'currentColor' }),
  pencil: (s = 14) => icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>', { size: s, sw: 1.8 }),
  archive: (s = 14) => icon('<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>', { size: s, sw: 1.8 }),
  trash: (s = 14) => icon('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6"/><path d="M10 11v6M14 11v6"/>', { size: s, sw: 1.8 }),
  check: (s = 26, stroke = 'var(--teal)') => icon('<path d="M20 6 9 17l-5-5"/>', { size: s, sw: 2.2, stroke }),
  reply: (s = 14) => icon('<path d="M9 17 4 12l5-5M4 12h12a4 4 0 0 1 4 4v2"/>', { size: s, sw: 1.8 }),
  file: (s = 13, stroke = 'currentColor') => icon('<path d="M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>', { size: s, sw: 1.8, stroke }),
  folder: (s = 14, stroke = 'var(--teal)') => icon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>', { size: s, sw: 1.8, stroke }),
  terminal: (s = 14) => icon('<path d="m4 17 6-6-6-6M12 19h8"/>', { size: s, sw: 1.9 }),
  split: (s = 15) => icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>', { size: s, sw: 1.8 }),
  panelHide: (s = 15) => icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m20 9-2 3 2 3"/>', { size: s, sw: 1.8 }),
  panelShow: (s = 15) => icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m18 9 2 3-2 3"/>', { size: s, sw: 1.8 }),
  play: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  code: (s = 15) => icon('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', { size: s, sw: 1.9 }),
};
