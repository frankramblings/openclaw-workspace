# OpenClaw Workspace — Visual Design Specification

A cleanroom reproduction spec. It documents the **current** visual language precisely
enough that a designer or agent who has never seen the app could rebuild its look and
feel. Values are measured from the live stylesheet; treat them as the source of truth.

> **How to use this:** Build the token layer first (§2), then the layout shell (§3),
> then components (§4). The token system is load-bearing — almost every component color
> is `var(--token)`, so getting §2 right makes the rest fall into place. The
> "Signature identity" boxes flag the handful of choices that *make it look like this
> app*; if you only get those right, it will already read as a faithful copy.

---

## 1. Character & Identity

A **dark-first, developer-grade agent workspace**. It feels like a well-made terminal
that grew a comfortable UI: monospace body text, a cool One-Dark background, a single
warm coral accent, hairline teal borders, and restrained motion. It is calm and dense
rather than playful or glossy — no big shadows in the content area, no gradients, no
rounded-everything softness. The one moment of personality is the **agent "synapse"
thread** that draws a glowing vertical nerve down the side of tool calls.

**Signature identity — get these five right above all:**

1. **Coral-on-cyan-on-charcoal palette.** Background `#282c34` (One Dark charcoal),
   body text `#9cdef2` (soft cyan), and a single accent `#e06c75` (coral/salmon) used
   for *everything* interactive — links, active states, the send button, focus rings,
   the agent thread. Borders are a muted teal `#355a66`.
2. **Monospace body, sans chrome.** Chat and content are **Fira Code**; modals/settings
   switch to **Inter**. This split is deliberate and very recognizable.
3. **Asymmetric chat bubbles.** Both bubbles use a `18px` radius with **one square
   corner** pointing at their origin: user `18 18 0 18` (square bottom-right), agent
   `18 18 18 0` (square bottom-left). 1px bordered, near-flat fills.
4. **The agent-thread "synapse".** Tool calls render as an indented block with a thin
   vertical rail in 18%-opacity coral and a traveling pulse dot that animates while
   streaming. This is the app's one ornament.
5. **Transparent modal overlay.** Modals have **no dimming backdrop** — the overlay is
   click-through and only the floating card (with a soft `0 8px 32px` shadow) catches
   the eye. Surprising, but core to the feel.

---

## 2. Design Tokens

### 2.1 Theming model (read first)

The entire palette is driven by **five base colors**. A theme object is persisted in
`localStorage['odysseus-theme']` and injected onto `:root` as CSS custom properties at
first paint (before the app boots, to avoid a flash). Everything else is derived from
these five via `var()` references and `color-mix()`.

```jsonc
// localStorage['odysseus-theme']
{
  "colors": {
    "bg":     "#282c34",   // app background
    "fg":     "#9cdef2",   // primary text
    "panel":  "#111111",   // raised surfaces (sidebar, cards, modals, inputs)
    "border": "#355a66",   // all hairline borders
    "red":    "#e06c75",   // THE accent (a.k.a. --accent / --brand-color)
    "advanced": { /* optional per-surface overrides, see 2.6 */ }
  },
  "font":    "mono",        // mono | sans | serif | <custom family>
  "density": "comfortable", // compact | comfortable | spacious
  "bgPattern": "none"       // optional decorative body background
}
```

Two rules follow:

- **Derive, don't hardcode.** Syntax-highlight colors and many element fills are computed
  from `bg`/`fg`/`red` (HSL math) or mixed at use-site with `color-mix(in srgb, …)`.
  Reproduce the *relationships*, not just the swatches.
- **`--accent` ≈ `--red`.** Components reference `var(--accent, var(--red))`. With no
  theme override, the accent **is** the coral `#e06c75`. (A few workspace-added controls
  fall back to blue `#6ea8fe` only if `--accent` is literally unset; treat coral as
  canonical.)

### 2.2 Color — default Dark theme (the canonical look)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#282c34` | App background |
| `--fg` | `#9cdef2` | Primary text (soft cyan) |
| `--panel` | `#111111` | Raised surfaces — **darker than bg** (sidebar, cards, modals, inputs) |
| `--border` | `#355a66` | All hairline borders (1px) |
| `--red` / `--accent` / `--brand-color` | `#e06c75` | The one accent |
| `--green` | `#50fa7b` | Success (rare in chrome) |
| `--warn` | `#f0ad4e` | Warning |

> Note the inversion: `panel` (#111) is **darker** than `bg` (#282c34). Raised surfaces
> recede into near-black rather than lifting toward white. Don't "correct" this.

### 2.3 Color — Light theme (alternate)

| Token | Value |
|---|---|
| `--bg` | `#f5f5f5` |
| `--fg` | `#2b2b2b` |
| `--panel` | `#ffffff` |
| `--border` | `#bbbbbb` |

Activated by `:root.light`. `--red`/accent stays coral. Inputs/buttons additionally get
`background:#eaeaea; color-scheme:light` under `:root.light`.

### 2.4 Color — Semantic & status (theme-independent constants)

| Token | Value | Use |
|---|---|---|
| `--color-error` | `#ff4444` | Errors (light `#ff6666`) |
| `--color-success` | `#4caf50` | Success |
| `--color-warning` | `#f0ad4e` | Warnings |
| `--color-danger` | `#c0392b` | Destructive |
| `--color-recording` | `#ff3b30` | Recording (hover `#d63031`) |
| `--color-accent` | `#00aaff` | Secondary "info" accent (rail active bg tint) |
| `--color-brand-blue` | `#3b82f6` | — |
| `--color-muted` | `#888888` | Muted text |
| `--color-muted-alt` | `#6b7280` | Muted text (footers) |
| `--color-link-hover` | `#66c7ff` | Link hover |

**Gateway/connection status dots** (fixed colors, not themed):
`ok #34c759` · `restarting #ff9f0a` (pulse) · `down #ff3b30` · `idle/unknown #8e8e93`.

**Inbox source chips** — pastel-on-dark, `rgba(...,0.18)` fill + solid text:

| Source | Fill | Text |
|---|---|---|
| Gmail | `rgba(234,67,53,.18)` | `#ef4444` |
| Slack | `rgba(56,189,248,.18)` | `#38bdf8` |
| Asana | `rgba(240,106,106,.18)` | `#fb7185` |
| Obsidian | `rgba(139,92,246,.18)` | `#a78bfa` |
| Documents | `rgba(20,184,166,.18)` | `#14b8a6` |

### 2.5 Color — Syntax highlighting (derived)

Dark defaults: `--hl-keyword #c678dd` (purple), `--hl-string #e5c07b` (gold),
`--hl-comment #828997` (grey), `--hl-function #61afef` (blue), `--hl-number #d19a66`
(orange), `--hl-builtin #56b6c2` (teal), `--hl-variable #abb2bf`, `--hl-params #a8c0d4`,
on `--hl-bg #1e2228`. This is the **One Dark** scheme. In practice these are recomputed
from the theme's `bg/fg/red` in HSL so a recolored theme produces a matching code theme
(keyword = accent hue +280°, string = hue 40°, function = hue 210°, etc.).

### 2.6 Per-surface advanced overrides (optional)

These have **no default** — components reference them with a fallback, so they only take
effect if a theme sets them: `--user-bubble-bg` (fallback `color-mix(in srgb, var(--fg)
8%, var(--bg))`), `--ai-bubble-bg` (`var(--panel)`), `--bubble-border` (`var(--border)`),
`--sidebar-bg` (`var(--panel)`), `--input-bg` (`var(--panel)`), `--input-border`
(`var(--border)`), `--send-btn-bg` (`var(--red)`), `--send-btn-hover` (`color-mix(in
srgb, var(--red) 80%, white)`), plus `--code-bg/-fg`, `--toggle-bg/-active`,
`--accent-primary`, `--accent-error`. Reproduce the **fallbacks** for the default look.

### 2.7 Typography

**Families** (set via `--font-family`, default `mono`):

| Key | Stack | Used for |
|---|---|---|
| `mono` *(default)* | `'Fira Code', monospace` | Body, chat, everything outside modals |
| `sans` | `system-ui, -apple-system, 'Segoe UI', sans-serif` | — |
| `serif` | `Georgia, 'Times New Roman', serif` | — |
| **Inter (fixed)** | `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` | **Modals / settings chrome only** |

Self-hosted `@font-face` (woff2, `font-display:swap`): **Fira Code** 300/400/600;
**Inter** 400/500/600. Code/`pre` is `0.95em / line-height 1.5`.

**Base size & density** — root `font-size` set by density class (everything else is `em`/`rem`/`px` off this):

| Density | root font-size | Bubble padding |
|---|---|---|
| compact | `13px` | `6px 10px` |
| comfortable *(default)* | browser default (`16px`) | `10px 12px` |
| spacious | `16px` | `14px 18px` |

**Type scale (de-facto, by role):**

| Role | Size | Weight | Notes |
|---|---|---|---|
| Chat body | `0.95em` | 400 | line-height `1.5` |
| Message role label | inherit | 600 | + 8px status dot before it |
| Timestamp (in bubble) | `10px` | 400 | 45% fg, opacity .7 |
| Message footer / actions | `0.75rem` | 400 | muted-alt |
| Composer textarea | `14px` (→`16px` on touch) | 400 | line-height 1.5 |
| Modal body | `14px` | 400 | Inter, letter-spacing `-0.015em` |
| Modal title `h4` | `1rem` | 600 | coral, letter-spacing `-0.03em` |
| Card heading | `14px` | 600 | letter-spacing `-0.03em`, 1px bottom rule |
| Tab label | `12px` | 400→active coral | |
| Small input | `11px` | 400 | |
| Agent-thread header | `0.85em` | — | 70% fg; tool name 600 UPPERCASE, 0.3px tracking |
| List item / cron / inbox title | `13.5px` | 550–600 | |

> Negative letter-spacing (`-0.015em` to `-0.03em`) on Inter headings is part of the
> "tight, designed" feel of the modal chrome. Keep it.

### 2.8 Spacing

No formal scale; the de-facto step set is **2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 ·
22 · 28 px**. Component padding clusters at `8–14px`; flex `gap`s at `4–12px`; vertical
rhythm between blocks `8–10px`. Chat content is centered in an `800px` max column
(`--chat-max`), gutters auto.

### 2.9 Radius

| Token-ish | Value | Used for |
|---|---|---|
| xs | `4px` | action-button hover targets, tiny chips |
| sm | `6px` | rail buttons, small inputs, code blocks, icon buttons |
| md | `8px` | **standard** — buttons, cards, list items, toasts |
| lg | `10–12px` | modals (10), generic bubbles base (12) |
| xl | `14–16px` | cron card (14), **chat input bar (16)** |
| **bubble** | `18px` w/ one square corner | **chat bubbles (signature, see §4.4)** |
| pill | `999px` | filter chips, recommendation chips |
| circle | `50%` | status dots, avatar dot, toggle knobs |

### 2.10 Borders, shadows, focus

- **Borders:** `1px solid var(--border)` is the universal divider/outline. Active tab =
  `2px` coral bottom border. Danger cards = `color-mix(--color-error 27%, transparent)`.
- **Shadows** (used sparingly; content area is essentially flat):
  - Sidebar: `0 4px 12px rgba(0,0,0,.1)`
  - Modal card: `0 8px 32px rgba(0,0,0,.45)`
  - Mobile sidebar overlay: `4px 0 20px rgba(0,0,0,.5)`
  - Cron card: `0 18px 60px rgba(0,0,0,.45)` · Toast: `0 4px 18px rgba(0,0,0,.4)`
  - Toggle knob: `0 1px 2px rgba(0,0,0,.25)`
- **Focus:** global `:focus-visible` → `outline: 2px solid var(--red); outline-offset:
  2px` (components may tighten to 1px/1px).
- **Scrollbars:** thin; thumb `var(--red)` on track `var(--panel)`, `4px` radius, hover
  lightens 20% toward white.

### 2.11 Motion

| Speed | Value | Used for |
|---|---|---|
| micro | `0.08s` | toggles, tabs, rail hover |
| small | `0.12–0.15s` | hovers, swipe labels, toasts |
| standard | `0.25s ease` | sidebar collapse, modal enter |
| content | `0.3s ease-out` | message enter, send-button width |
| exit | `0.18s ease-in` | modal close |

**Signature easing curves:** bouncy spring `cubic-bezier(0.34, 1.56, 0.64, 1)` (welcome
screen, expressive transitions); send-button width `cubic-bezier(0.34, 1, 0.64, 1)`.

Honor `@media (prefers-reduced-motion: reduce)` — all the looping animations below drop
to a static state.

**Keyframe catalog:**

- `msg-enter` (0.3s): `opacity 0→1`, `translateY(10px→0)`.
- `modal-enter` (0.25s): `opacity 0→1`, `scale(.95→1) translateY(8px→0)`.
- `modal-exit` (0.18s, class `.modal-closing`): `scale(1→.97) translateY(0→6px)`, fade.
- `synapse-*` (0.8s loop): a 4px coral dot travels the agent-thread rail while streaming.
- `thread-pulse` (1.5s): running tool dot gets a pulsing `0 0 0 3px` coral halo.
- `gw-pulse` (1.2s): restarting status dot blinks to 35% opacity.
- `*-notif-breathe` (2.2s): unread dots breathe.
- `fl-grow`/`fl-shard` (1.35s): the boot/“thinking” crystal loader (§4.13).

### 2.12 Z-index layers

`1–2` in-flow chrome → `5` sticky modal header → `10` resize handles → `199` sidebar
backdrop → `200` mobile sidebar/rail overlays → `250` **modal overlay** → `260` cookbook
→ `300` gateway banner → `9000` cron/inbox overlay → `99999` boot loader → `100000`
pull-to-refresh. Keep the **modal layer at 250** and overlays below it.

### 2.13 Iconography

- **Rail & sidebar icons:** **line-stroke SVGs** (NOT emoji), `16×16` on the rail /
  `12–13px` on sidebar section titles, `viewBox 0 0 24 24`, `fill:none`,
  `stroke=currentColor` (= accent), `stroke-width 2` (the Search and New-chat icons use
  `2.5`), round joins/caps. The only entity-glyph in the rail is the delete **✕**
  (U+2715). Full inventory in Appendix A.
- **Route favicons & decorative icons:** same outline language at `viewBox 0 0 32 32`,
  `stroke-width 2.5`, stroked in the live accent (calendar, notes, email envelope,
  memory "brain", checklist, library spines, etc.). Match this style for any new icon —
  outline, not filled.
- **Brand mark:** a single-color CSS mask (`/static/logo.svg`) that inherits
  `currentColor` so it always paints in the accent.

---

## 3. Layout System

### 3.1 App shell (desktop)

Body is `display:flex` row, full `100dvh`, `overflow:hidden`. Three columns, left→right:

```
┌────┬───────────┬───────────────────────────────────────┐
│ 48 │  240px    │  chat container (flex:1)               │
│ px │  sidebar  │  ┌─ chat-top-bar (centered title) ──┐  │
│rail│  (panel)  │  │                                   │  │
│    │           │  │  chat-history (800px max, auto    │  │
│ ▢  │  sections │  │  centered column)                 │  │
│ ▢  │  + list   │  │                                   │  │
│ ▢  │           │  ├─ chat-input-bar (800px max) ──────┤  │
│ ⚙  │           │  └───────────────────────────────────┘  │
└────┴───────────┴───────────────────────────────────────┘
```

| Element | Spec |
|---|---|
| **Icon rail** | `width:48px`, `flex-shrink:0`, `bg:--panel`, `border-right:1px --border`, vertical flex, `align-items:center`, `padding:48px 4px 8px` (top 48 leaves room for the hamburger / safe-area), `gap:4px`. Has a drag handle on its right edge. |
| **Rail button** | `34×34`, transparent, `border-radius:6px`, accent-colored glyph `16px`, **`opacity:0.5` at rest**. Hover → `opacity:1` + `color-mix(--accent 12%, transparent)` bg. Active section → `opacity:1` + `color-mix(--color-accent 15%, transparent)` bg. Optional `6×6` accent badge dot (top-right, `0 0 0 2px var(--bg)` ring). |
| **Rail divider** | `24px × 1px`, `--border`, `4px` vertical margin. |
| **Sidebar** | `width:240px`, `bg:--sidebar-bg(=panel)`, `border-right:1px --border`, column flex, `box-shadow:0 4px 12px rgba(0,0,0,.1)`, subtle `backdrop-filter:blur(10px)`. Collapses to `width:0` (`.hidden`). Drag handle on right edge (hover → accent). |
| **Sidebar sections** | `.section` is a transparent wrapper; visual weight comes from headers + list items (collapsible, chevron rotates). Right-aligned `6px` notif dots in accent. |
| **Chat container** | `flex:1`, column, `padding:0 16px`, `margin-top:8px`. |
| **Chat top bar** | centered title, `min-height:25px`, `padding:5px 0 0`, `z-index:2`. When the sidebar is collapsed it indents 38px toward the hamburger side. |
| **Chat history** | scrolls; content centered in `--chat-max:800px` via auto `padding-left/right: max(…, (100% - 800px)/2)`. |
| **Composer (`chat-input-bar`)** | `bg:--input-bg(=panel)`, `border:1px --input-border(=border)`, `border-radius:16px`, `padding:10px 12px`, column flex, `gap:8px`, `max-width:800px`, centered. Textarea is transparent/borderless inside it (`14px`, auto-grow `24→200px`). Bottom row spreads controls. |

CSS vars `--icon-rail-w` (48px) and `--sidebar-w` track live widths so desktop tool
**modals offset** to start after the rail+sidebar: `left: calc(var(--icon-rail-w) +
var(--sidebar-w))` with a matching width, transitioning `0.25s`.

### 3.2 Responsive

Primary breakpoint **`max-width:768px`** (a ladder of minor ones exist: 820/720/700/640/
620/520/500/480/460, plus height breakpoints 650/500/380 and `hover/pointer` queries).
At ≤768px:

- **Icon rail** hides; a `.mobile-mini` 48px fixed rail can slide in (`z-index:200`,
  `2px 0 12px` shadow).
- **Sidebar** becomes a fixed **overlay drawer**: `position:fixed; inset-block:0;
  width:80%; max-width:340px; z-index:200; 4px 0 20px shadow`; `.hidden` →
  `translateX(-100%)`. A `#sidebar-backdrop` (`rgba(0,0,0,.4)`, z-199) fades in behind it.
- **Chat container** → `padding:10px; padding-top:42px; margin-top:0`.
- **Send button** grows to `48×48`, `border-radius:12px`.
- **Touch sizing:** list items / headers / search / new-chat get `min-height:48px`,
  `padding:12px 10px`, `font-size:14px`, `border-radius:8px`.
- **Inputs forced to `16px`** on coarse pointers (prevents iOS focus-zoom).

**Tool modals become bottom sheets** at ≤768px: full `100dvh`, `width:100vw`,
`border-radius:14px 14px 0 0`, slide-up (`sheet-enter 0.2s`), with `env(safe-area-inset-
top/bottom)` padding so the iOS status bar and home indicator are respected. The Inbox is
an edge-to-edge sheet with a `36×4px` grabber pill and swipe-to-dismiss.

### 3.3 Safe-area / PWA

Installed PWA uses `apple-mobile-web-app-status-bar-style: black-translucent`, so **top
chrome must add `env(safe-area-inset-top)`**: hamburger `top: 12px + inset`, rail
`padding-top: 48px + inset`, sidebar header `+ inset`, chat top bar `+ inset`. Bottom:
composer and sheets add `env(safe-area-inset-bottom)`. `theme-color` meta tracks the
theme `bg`. `overscroll-behavior-y:none` in standalone mode to protect pull-to-refresh.

---

## 4. Component Specifications

Each component: **anatomy → exact values → states**. Colors are tokens from §2.

### 4.1 Icon-rail button
See §3.1. Rest `opacity .5`; hover `1` + 12% accent wash; active `1` + 15% info-accent
wash; `border-radius 6px`; optional pulsing badge dot for minimized/notify state.

### 4.2 Sidebar list item & section header
Transparent rows; hover gets a faint wash; collapse chevron rotates `90°` when open
(`0.2s`). Right-aligned `6×6` accent notif dot (`#email-unread-dot`/`#inbox-unread-dot`
add a 2.2s breathing animation). Touch targets ≥48px on mobile.

### 4.3 Chat message — container
`.msg`: column flex, `width:fit-content`, `max-width:85%`, `min-width:80px`,
`margin:8px 0`, `padding:10px 12px` (density-dependent), `line-height:1.4`,
`overflow:hidden`, enters with `msg-enter 0.3s`.

### 4.4 Chat bubbles — user vs agent **(signature)**

| | User | Agent |
|---|---|---|
| Align | right (`margin-left:auto`, `margin-right:8px`) | left (`margin-right:auto`, `margin-left:8px`) |
| Fill | `--user-bubble-bg` → `color-mix(--fg 8%, --bg)` | `--ai-bubble-bg` → `--panel` |
| Border | `1px solid --bubble-border(=border)` | same |
| **Radius** | **`18px 18px 0 18px`** (square bottom-right) | **`18px 18px 18px 0`** (square bottom-left) |
| Width | `max-width:85%` | `width:85%` (fills the column) |

The square corner points "down toward" the speaker's side — the single most identifying
visual detail. Reproduce exactly.

### 4.5 Message role + avatar dot
`.role`: `font-weight:600`, `gap:6px`, with a **`::before` 8×8 circle** in
`--model-dot` (`color-mix(--fg 30%, transparent)`) as a tiny avatar. User role text is
`color-mix(--fg 60%, transparent)` with a 40% dot. A provider logo (12×12 svg) replaces
the dot when present (`.has-logo` hides the `::before`).

### 4.6 Message body, timestamp, footer
- Body: `0.95em`, `line-height:1.5`, `word-break:break-word`, children spaced 8px.
- Timestamp: `10px`, `color-mix(--fg 45%, transparent)`, right-aligned, opacity .7.
- Footer (`.msg-footer`): `0.75rem`, `--color-muted-alt`, flex with `6px` gap. Action
  buttons (`copy/regen/fork/shorten/delete`): bare, `1.1rem` glyph, `padding:2px 6px`,
  `border-radius:4px`, hover → accent (delete hover → `--red`).

### 4.7 Agent thread / tool call **(signature)**
Indented block: `margin:2px 0 2px 28px`, `padding:4px 0 4px 22px`,
`max-width:calc(85% - 20px)`.
- **Rail (`::before`):** absolute, `left:5px`, `top:14px → bottom:14px`, `width:2px`,
  `background: color-mix(--red 18%, transparent)`, `border-radius:1px`. (`.has-top`/
  `.has-bottom` extend it to join adjacent nodes.)
- **Streaming pulse (`::after`):** a `4×4` coral dot with `0 0 3px 1px` coral glow that
  travels the rail (`synapse-* 0.8s` loop) while `.streaming`; hidden otherwise.
- **Node dot:** `8×8` coral circle at `left:-20px`, `2px` `--bg` ring. Running → pulsing
  `0 0 0 3px` halo (`thread-pulse 1.5s`); error → `--color-error`.
- **Header:** `0.85em`, 70% fg (hover full), chevron rotates when open; **tool name**
  600-weight UPPERCASE coral, `0.3px` tracking; elapsed time `11px` tabular coral.
- **Command block:** `color-mix(--fg 5%, transparent)` bg, `1px --border`,
  `border-radius:6px`, `padding:8px 12px`.
- **Stall banner:** warning-tinted (`color-mix(--color-warning 12%, --bg)` bg, 40% border).

### 4.8 Composer & send button
Composer: see §3.1. **Send button** `.send-btn`: `32×32`, `bg:--send-btn-bg(=red)`,
white glyph, `border-radius:8px`. Hover → `--send-btn-hover` (`color-mix(--red 80%,
white)`). It **morphs** by mode: mic/new-chat modes drop to a `30% accent / panel` fill
with `--fg` glyph and a border; width animates with the spring curve; `.send-pending`
dims to .55 and pulses. Mobile → `48×48`, radius 12.

### 4.9 Modal **(signature overlay behavior)**
- **Overlay (`.modal`):** `position:fixed; inset:0; z-index:250; display:flex;
  center/center;` **`background:none; backdrop-filter:none; pointer-events:none`** — no
  dimming, click-through. `.hidden` → `display:none`.
- **Card (`.modal-content`):** `bg:--panel`, `1px --border`, `border-radius:10px`,
  `width:min(520px, 92vw)`, `max-height:85vh`, `padding:10px`, **`font-family:Inter`**,
  `font-size:14px`, `letter-spacing:-0.015em`, `box-shadow:0 8px 32px rgba(0,0,0,.45)`,
  `pointer-events:auto`, enters with `modal-enter 0.25s`, closes with `.modal-closing`
  → `modal-exit 0.18s`.
- **Header:** sticky top, `cursor:grab` (draggable), space-between; title `h4` `1rem`
  600 **coral**, `letter-spacing:-0.03em`.
- **Body:** `flex:1; overflow-y:auto`. Footer is a simple flex action row.
- **Mobile:** becomes the bottom sheet of §3.2.

### 4.10 Cards, panels, tabs
- **Card (`.admin-card`):** `bg:--panel`, `1px --border`, `border-radius:8px`,
  `padding:12px`, `margin-bottom:10px`. Heading `h2`: `14px/600`,
  `letter-spacing:-0.03em`, `6px` bottom padding + `1px` 40%-border rule.
- **Danger card:** same but `border-color: color-mix(--color-error 27%, transparent)`.
- **Tabs (`.admin-tab`):** bare, `12px`, `padding:6px 14px`, `border-bottom:2px solid
  transparent`, muted text. Hover → full fg. **Active → coral text + coral 2px underline.**

### 4.11 Toggles / switches
Three variants exist; the canonical one:
- **`.admin-switch`:** track `30×16`, `border-radius:8px`, off `color-mix(--fg 50%,
  transparent)`, **on `--red`**. Knob `12×12` circle, `--panel`, `0 1px 2px` shadow,
  translates `+14px` when on. Transition `0.08s`.
- Workspace variants: cron toggle `34×19`, knob `15×15` white, on `--accent`; skills
  toggle `30×17`, on **`#34c759`** (green) — used where "enabled = good/on" semantics
  read better than accent.

### 4.12 Inputs, chips, banners
- **Input (small):** `height:24px`, `padding:0 8px`, `border-radius:6px`, `1px --border`,
  `bg:--bg`, `font-size:11px`. Focus → `border-color:--red`, no outline.
- **Filter/rec chips:** pill (`999px`), `padding:2px 10px`, `~11px`. Source chips per
  §2.4. Active chip → `outline:1px solid currentColor`. Recommendation "✨" chip uses
  a purple wash (`rgba(187,154,247,.14)` / border `.3`).
- **Cron schedule chip:** `11px`, `padding:1px 6px`, `border-radius:6px`, grey wash bg,
  accent text.
- **Gateway banner (`#gw-banner`):** fixed top, `z-index:300`, warning-tinted
  (`rgba(255,159,10,.14)` bg, `1px` 45%-amber bottom border), `13px`, dismiss on right.
- **Toast:** absolute bottom-center, `bg:--panel`, `1px --border`, `border-radius:8px`,
  `padding:8px 14px`, `12.5px`, `0 4px 18px` shadow; primary action gets an accent wash.

### 4.13 Loaders & status dots
- **Boot / thinking loader ("Fortress"):** animated crystal SVG — 7 crystals grow/shrink
  in staggered sequence (`fl-grow 1.35s`, 80–490ms delays) with 3 shards bursting
  (`fl-shard`, 720–860ms delays). Tinted with `--brand-color`. Reduced-motion → static.
- **Status dots:** `10×10` circle for gateway (sidebar twin `8×8`); `6×6` for sidebar
  unread (breathing). Colors per §2.4.

---

## 5. Reproduction Checklist (acceptance)

A faithful rebuild should pass all of these by eye:

- [ ] Background is One-Dark charcoal `#282c34`; text is soft cyan `#9cdef2`; raised
      surfaces are **darker** near-black `#111`.
- [ ] Exactly one accent — coral `#e06c75` — on links, send button, focus rings, active
      tabs, agent thread, toggles.
- [ ] Body/chat is **Fira Code** (monospace); modals/settings are **Inter** (sans).
- [ ] Chat bubbles are 1px-bordered, near-flat, `18px` radius with **one square corner**
      (user bottom-right, agent bottom-left); agent bubble fills the column, user hugs right.
- [ ] Tool calls render as an indented block with a thin coral vertical rail and a
      traveling pulse dot while streaming.
- [ ] Modals float with a soft shadow over a **non-dimmed, click-through** overlay; their
      title is coral; they're draggable by the header.
- [ ] Layout is `48px` rail + `240px` sidebar + centered `800px` chat column; rail
      buttons sit at 50% opacity until hovered/active.
- [ ] Borders are hairline teal `#355a66`; the content area is essentially shadowless and
      flat; motion is quick (`0.08–0.3s`) with an occasional bouncy spring.
- [ ] At ≤768px the sidebar is an overlay drawer, tool modals are bottom sheets with a
      grabber, and safe-area insets keep chrome clear of the notch/home indicator.
- [ ] Recoloring the five base tokens (`bg/fg/panel/border/red`) recolors the whole UI,
      including a matching derived code-syntax theme.

---

*Source of record: `frontend/style.css` (canonical component values) and
`frontend-overrides/` (workspace additions: source chips, cron, inbox, gateway status,
skills toggle, loader, PWA safe-area). Theme injection logic:
`frontend-overrides/index.html` inline `<script>`.*

---

## Appendix A — Content & Structure Reference

§1–§5 specify the **visual language** (a fresh build reproduces the *look*). This
appendix pins the **content and IA** a cleanroom build would otherwise have to invent —
the brand name, the exact rail/sidebar inventory, and the exact animation keyframes. Use
it when you need *pixel-and-structure-identical* reproduction rather than just the look.

### A.1 Brand / agent name

The display name is a build-time token (`__AGENT_NAME__`), **configurable**, default
**"Claw"**. It appears in: the document title (`"<name> Chat"`), the sidebar header
wordmark, the composer placeholder (`"Message <name>…"`), the agent's role label inside
agent bubbles, and per-route page titles (`"Calendar — <name>"`, etc.). Internal code
identifiers and the favicon are **not** renamed with it.

### A.2 Icon rail — inventory & order

Top→bottom. All entries are `16×16` line-stroke SVGs (`viewBox 0 0 24 24`, stroke 2,
`currentColor`) unless noted.

| # | Item | Icon | Notes |
|---|---|---|---|
| 1 | Search | magnifier | stroke **2.5**; opens Ctrl/⌘-K search |
| 2 | New chat | plus | stroke **2.5** |
| 3 | Delete session | **✕ glyph** (U+2715) | the one non-SVG |
| — | *divider* | `24×1px` `--border` | |
| 4 | Chats | chat bubble | **dynamic** — `display:none` until active |
| 5 | Documents | file | **dynamic** — hidden until active |
| 6 | Calendar | calendar | |
| 7 | Compare | nodes | *hidden in this workspace (no backend)* |
| 8 | Cookbook | book | *hidden* |
| 9 | Deep Research | magnifier-plus | |
| 10 | Email | envelope | |
| 11 | Gallery | image | *hidden* |
| 12 | Library | archive box | id `rail-archive` |
| 13 | Brain | brain/memory | id `rail-memory` (Memories + Skills + Cron) |
| 14 | Notes | note/pencil | |
| 15 | Tasks | checklist | *hidden* |
| 16 | Theme | contrast circle | |
| — | *spacer (flex)* | | pushes Settings to the bottom |
| 17 | Settings | gear | bottom-anchored |

> Compare / Cookbook / Gallery / Tasks are hidden via `display:none` (override layer —
> no backend wired). The **visible** rail is therefore: Search · New · Delete │
> [Chats/Documents when active] Calendar · Deep Research · Email · Library · Brain ·
> Notes · Theme … Settings.

### A.3 Sidebar — information architecture

Top→bottom. Section titles carry a `12–13px` line-stroke SVG icon; sections are
collapsible.

1. **Header** — brand mark + wordmark, with the gateway status twin-dot beside it.
2. **Chats** (`#sessions-section`) — chat-bubble icon + unread dot; header has
   Manage-Chats (Library) and Sort buttons; body = the session list.
3. **Inbox** — title is clickable, opens the unified inbox.
4. **Email** — title opens the mailbox; has a compose (＋) button.
5. **Models** — the model list; Sort button.
6. **Tools** — list-items, in order: **Brain** (Memory) · Calendar · Compare\* ·
   Cookbook\* · Deep Research · Gallery\* · Library · Notes · Tasks\* · Theme.
   (\* hidden, same set as the rail.)

### A.4 Animation keyframes (exact)

Already given in §2.11: `msg-enter`, `modal-enter`, `modal-exit`. The agent-thread set:

**Streaming pulse dot** (`.agent-thread.streaming::after`, a `4×4` coral dot, all
variants `0.8s ease-in-out infinite`). Which variant runs depends on whether the thread
joins neighbors above/below:

| Variant | When | Keyframes |
|---|---|---|
| `synapse-capped-short` | base (no join) | `0%{top:14px;opacity:0} 5%{opacity:.5} 70%{opacity:.35;top:calc(100% - 20px)} 100%{opacity:0;top:calc(100% - 20px)}` |
| `synapse-capped` | `.has-top` | same as above but starts `top:0%` |
| `synapse-travel-short` | `.has-bottom` | `0%{top:14px;opacity:0} 5%{opacity:.5} 85%{opacity:.35} 100%{top:100%;opacity:0}` |
| `synapse-travel` | `.has-top.has-bottom` | same as above but starts `top:0%` |

So: a "capped" run (no bottom neighbor) parks 20px short of the end and fades; a "travel"
run (has a bottom neighbor) rides all the way to `100%`. Short variants start at `14px`
(below the rail's inset top), full variants at `0%`.

**Node dot** (`.agent-thread-dot`): `8×8` coral, `left:-20px`, `top:10px`, `2px --bg`
border. When `.running`: a static `0 0 0 3px` coral@25% ring **plus**:

```css
@keyframes thread-pulse {        /* 1.5s ease-in-out infinite */
  0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--red) 20%, transparent); }
  50%      { box-shadow: 0 0 0 5px color-mix(in srgb, var(--red) 10%, transparent); }
}
```

**Looping dot animations elsewhere:** `rail-min-pulse` (2s, rail badge dots);
`email-notif-breathe` (2.2s, unread dots — opacity/scale breathe); `gw-pulse` (1.2s,
restarting gateway dot blinks to 35%). All disabled under `prefers-reduced-motion`.

### A.5 Corrections folded in from the cleanroom test

- Rail/sidebar icons are **line-stroke SVGs, not emoji** (§2.13 updated). A spec reader
  given the original wording reasonably produced emoji buttons.
- Agent-thread node dot is at **`top:10px`**, not header-baseline-aligned.
- The default streaming variant is **`synapse-capped-short`** (parks short + fades), not
  an end-to-end travel — that only applies when a bottom neighbor exists.
