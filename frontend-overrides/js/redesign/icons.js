// Inline Lucide/Feather-style line icons for the redesign shell.
// Each helper returns an <svg> string. stroke=currentColor so color is inherited.

const A = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

/** Generic icon from a path body. */
export function icon(body, { size = 18, sw = 1.7, stroke = 'currentColor', fill = 'none', vb = 24 } = {}) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
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
  check: (s = 26, stroke = 'var(--teal)') => icon('<path d="M20 6 9 17l-5-5"/>', { size: s, sw: 2.2, stroke }),
  reply: (s = 14) => icon('<path d="M9 17 4 12l5-5M4 12h12a4 4 0 0 1 4 4v2"/>', { size: s, sw: 1.8 }),
  file: (s = 13, stroke = 'currentColor') => icon('<path d="M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>', { size: s, sw: 1.8, stroke }),
  folder: (s = 14, stroke = 'var(--teal)') => icon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>', { size: s, sw: 1.8, stroke }),
  terminal: (s = 14) => icon('<path d="m4 17 6-6-6-6M12 19h8"/>', { size: s, sw: 1.9 }),
  split: (s = 15) => icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>', { size: s, sw: 1.8 }),
  panelHide: (s = 15) => icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m20 9-2 3 2 3"/>', { size: s, sw: 1.8 }),
  panelShow: (s = 15) => icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m18 9 2 3-2 3"/>', { size: s, sw: 1.8 }),
  play: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
};
