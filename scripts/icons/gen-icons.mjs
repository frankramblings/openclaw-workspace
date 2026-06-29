// Generate all brand assets.
//
//   cd scripts/icons && npm install && npm run gen
//
// Mode + name + accent resolve from env > .data/branding.json > defaults, so
// `scripts/setup.sh` (which writes branding.json) drives the icon with no flags.
//
// Two modes (WORKSPACE_ICON_MODE / branding.json "icon_mode"):
//   initials (DEFAULT) — synthesize a name-derived glyph: the agent's first
//                        letter in the accent on the app background. Every fresh
//                        install gets a distinct icon with no art step.
//   helmet             — render the pinned brand.src.svg line-art (below). The
//                        maintainer's private mark; opt in with icon_mode=helmet.
//
// brand.src.svg is a two-tone illustration: the mark .ink. is the white
// (.cls-1, #fff) paths; the black card + interior + detail dots are the default
// black fill. The old Odysseus boat icon was a single color via currentColor,
// so we reduce the mark to one color the same way: white ink -> the color we want,
// every black path -> transparent (fill:none). The result is accent-colored
// helmet line-art on a transparent background.
//
// Outputs (written to BOTH frontend/ and frontend-overrides/):
//   logo.svg          mono, opaque ink — used as a CSS mask so in-UI logos take
//                     the live --brand-color (exactly how the boat tracked the
//                     theme accent).
//   favicon.svg       mono, accent-colored — standalone tab icon (can't inherit
//                     page color, so the accent is baked in).
//   favicon-16/32, apple-touch-icon, icon-192/512, maskable-icon (PNG, accent).
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIRS = [join(ROOT, 'frontend'), join(ROOT, 'frontend-overrides')];

// Single source of truth: env wins, else .data/branding.json, else defaults —
// the same precedence config.py uses, so the icon matches the rest of the UI.
function loadBranding() {
  try {
    return JSON.parse(readFileSync(join(ROOT, '.data', 'branding.json'), 'utf8'));
  } catch { return {}; }
}
const branding = loadBranding();
const AGENT_NAME = process.env.WORKSPACE_AGENT_NAME || branding.agent_name || 'Claw';

// App background and theme accent. The accent is baked into the static
// favicon/PNG assets; in-UI logos stay dynamic via the CSS mask.
const BG = '#282c34';
const ACCENT = process.env.WORKSPACE_ACCENT || branding.accent || '#4fe3d1';

const src = readFileSync(join(HERE, 'brand.src.svg'), 'utf8');

// Reduce the two-tone illustration to a single-color mask shape.
//   placeholder __INK__ marks the helmet ink so we can recolor per output.
function mono(inkColor) {
  let s = src.replace(/fill:\s*#fff;?/i, `fill: ${inkColor};`);
  // Black paths/ellipses (no class, no explicit fill) -> transparent.
  s = s.replace(/<path (?!.*class=)/g, '<path fill="none" ');
  s = s.replace(/<ellipse (?!.*class=)/g, '<ellipse fill="none" ');
  return s;
}

// Initials mode: the agent's first letter as the mark. Single glyph reads best
// at favicon sizes; non-letters are skipped, falling back to 'A' if empty.
function initials(name) {
  const letter = [...(name || '')].find((c) => /[a-z0-9]/i.test(c));
  return (letter || 'A').toUpperCase();
}
function initialsSvg(inkColor) {
  const ch = initials(AGENT_NAME);
  // viewBox matches the helmet's 512 space so the sharp pipeline is identical.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`
    + `<text x="256" y="256" text-anchor="middle" dominant-baseline="central" `
    + `font-family="Helvetica, Arial, sans-serif" font-weight="800" `
    + `font-size="340" fill="${inkColor}">${ch}</text></svg>`;
}

// initials is the default; helmet is the maintainer's opt-in private mark.
const MODE = (process.env.WORKSPACE_ICON_MODE || branding.icon_mode || 'initials').toLowerCase();
const makeMark = MODE === 'helmet' ? mono : initialsSvg;
console.log(MODE === 'helmet'
  ? 'icon mode: helmet (brand.src.svg)'
  : `icon mode: initials ('${initials(AGENT_NAME)}' for "${AGENT_NAME}")`);

// logo.svg: opaque ink (#000) — color is irrelevant for a CSS mask, only alpha.
const logoSvg = makeMark('#000');
// favicon.svg: ink baked to the theme accent.
const faviconSvg = makeMark(ACCENT);

const SQUARE = [
  ['favicon-16x16.png', 16],
  ['favicon-32x32.png', 32],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];
const MASK_SIZE = 512;
const MASK_INNER = Math.round(MASK_SIZE * 0.72);
const MASK_PAD = Math.round((MASK_SIZE - MASK_INNER) / 2);

for (const dir of OUT_DIRS) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'logo.svg'), logoSvg);
  writeFileSync(join(dir, 'favicon.svg'), faviconSvg);
  console.log(`wrote ${join(dir, 'logo.svg')} + favicon.svg`);

  for (const [name, size] of SQUARE) {
    await sharp(Buffer.from(faviconSvg), { density: 300 })
      .resize(size, size, { fit: 'contain', background: BG })
      .flatten({ background: BG })
      .png()
      .toFile(join(dir, name));
    console.log(`wrote ${join(dir, name)} (${size}x${size})`);
  }

  const inner = await sharp(Buffer.from(faviconSvg), { density: 300 })
    .resize(MASK_INNER, MASK_INNER, { fit: 'contain', background: BG })
    .flatten({ background: BG })
    .png()
    .toBuffer();
  await sharp(inner)
    .extend({ top: MASK_PAD, bottom: MASK_PAD, left: MASK_PAD, right: MASK_PAD, background: BG })
    .png()
    .toFile(join(dir, 'maskable-icon.png'));
  console.log(`wrote ${join(dir, 'maskable-icon.png')} (${MASK_SIZE}x${MASK_SIZE}, ${MASK_INNER}px safe)`);
}

console.log('done.');
