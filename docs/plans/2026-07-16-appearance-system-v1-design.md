# Appearance System v1 Design

## Goal

Build Appearance into a real preference system for the Workspace PWA, not a one-off collection of toggles. The first version should let Frank compare typography choices immediately, tune the chat reading experience, and establish a durable foundation for color, density, motion, and code/terminal presentation.

## Current State

The redesign settings surface already has an `appearance` section in `frontend-overrides/js/redesign/settings-data.js`, but it is mostly static:

- Theme is only wired to accent swatches.
- Sidebar, Chat Area, and Chat Bar visibility toggles are local UI flags.
- The old full theme picker was intentionally not ported; audit notes identify the missing theme picker as a parity gap.
- `frontend-overrides/js/redesign/live/settings.js` hydrates a small set of live values and persists accent through `/api/prefs/accent` and `/api/auth/settings`.
- The app's actual visual system is driven by CSS variables in `frontend-overrides/redesign.css`.

The right move is to extend the existing live settings path instead of rebuilding settings storage from scratch.

## Product Shape

Appearance becomes a settings section with five cards:

1. **Preview**
   - Shows a compact sample assistant message, user message, inline code, code block, button row, and terminal/path token.
   - Updates live as controls change.
   - Includes Reset to Gary Default.

2. **Typography**
   - Content/UI font family:
     - Bear Sans UI
     - Hanken Grotesk
     - System Sans
   - Code/mono font family:
     - MonoLisa
     - System Mono
   - Content size:
     - Small
     - Default
     - Large
   - Line height:
     - Tight
     - Comfortable
     - Open
   - Message width:
     - Focused
     - Standard
     - Wide

3. **Color**
   - Mode:
     - Dark
     - Light
     - System
   - Contrast:
     - Standard
     - High
   - Accent swatches plus custom hex.
   - User bubble style:
     - Subtle
     - Filled
     - Outline

4. **Layout**
   - Density:
     - Compact
     - Comfortable
     - Spacious
   - Sidebar:
     - Standard
     - Compact
     - Auto-collapse
   - Chat chrome:
     - Header visible
     - Welcome visible
     - Source/context collapsed by default

5. **Effects**
   - Motion:
     - Full
     - Reduced
     - Minimal
   - Transparency / blur:
     - On
     - Off
   - Sensitive blur:
     - On
     - Off

The first release should not expose per-token palette editing, generated color harmonies, theme JSON import/export, or named custom themes. Those belong in v2 once the base preference model is stable.

## Preference Model

Persist one `appearance` object in the existing settings bag:

```json
{
  "appearance": {
    "version": 1,
    "font": {
      "sans": "bear-sans-ui",
      "mono": "monolisa",
      "size": "default",
      "lineHeight": "comfortable",
      "messageWidth": "standard"
    },
    "color": {
      "mode": "dark",
      "contrast": "standard",
      "accent": "#4fe3d1",
      "userBubble": "subtle"
    },
    "layout": {
      "density": "comfortable",
      "sidebar": "standard",
      "chatHeader": true,
      "welcome": true,
      "collapseSources": true
    },
    "effects": {
      "motion": "full",
      "transparency": true,
      "sensitiveBlur": false
    }
  }
}
```

Storage stays in `.data/settings.json` through `POST /api/auth/settings` and `GET /api/auth/settings`, matching the current search/default-model settings pattern. The existing `/api/prefs/accent` call can remain for backwards compatibility during migration, but the new source of truth should be `settings.appearance.color.accent`.

## CSS Variable Contract

The live settings module should convert the appearance object into CSS variables and classes on `document.documentElement`.

Core variables:

- `--sans`
- `--prose`
- `--mono`
- `--content-font-size`
- `--content-line-height`
- `--message-max-width`
- `--accent`
- `--teal`
- `--teal2`
- `--tealtint`
- `--bg`
- `--panel`
- `--panel2`
- `--fg`
- `--mut`
- `--faint`

Root classes:

- `appearance-mode-dark`
- `appearance-mode-light`
- `appearance-contrast-high`
- `appearance-density-compact`
- `appearance-density-spacious`
- `appearance-motion-reduced`
- `appearance-motion-minimal`
- `appearance-no-transparency`

The app should not scatter direct style mutations across components. Component CSS should consume tokens/classes.

## Data Flow

1. App boots.
2. `live/settings.js` loads `/api/auth/settings`.
3. It merges `settings.appearance` over `DEFAULT_APPEARANCE`.
4. It applies CSS variables/classes before or during initial settings hydration.
5. Settings controls read from `runtime.state.appearance`.
6. Control changes update `runtime.state.appearance`, apply the CSS variables immediately, re-render, and persist the whole `appearance` object.
7. If persistence fails, the visible change remains for the current session and a toast reports that durability failed.

## Components

### `appearance.js` or `appearance-prefs.js`

Pure helpers:

- `DEFAULT_APPEARANCE`
- `normalizeAppearance(input)`
- `appearanceToCssVars(appearance)`
- `appearanceToRootClasses(appearance)`
- `applyAppearance(appearance, root = document.documentElement)`
- `patchAppearance(current, path, value)`

This module should be easy to unit test without a browser.

### `settings-data.js`

Add row types for:

- segmented controls
- sliders or step controls where needed
- select rows
- font preview rows
- reset row

Keep the panel declarative. Do not bury persistence in `settings-data.js`.

### `surfaces.js`

Render the new Appearance cards and controls. Use existing settings card patterns where possible.

### `live/settings.js`

Owns:

- hydration
- actions
- persistence
- fail-soft behavior
- migration from existing accent keys

Actions:

- `setAppearance(path, value)`
- `resetAppearance()`
- `setAccent(hex)` remains as a compatibility wrapper that patches `color.accent`
- existing `toggleUi` remains for non-appearance feature toggles

## Migration

On first load:

- If `settings.appearance` exists, use it.
- Else build from defaults plus any existing `accent` value from `/api/auth/settings`, `/api/config`, or local `oc-accent`.
- Persist the normalized v1 object only after the user changes an appearance control, not just on read.

Existing users should keep their accent color.

## Accessibility

- Controls must be keyboard reachable and have visible focus.
- Color swatches need labels/tooltips, not just color circles.
- High-contrast mode must increase text/border contrast, not only change the accent.
- Motion settings must override decorative animation even when OS `prefers-reduced-motion` is not set.
- OS `prefers-reduced-motion` still wins if the user leaves motion at Full.
- Light mode must update `meta[name="theme-color"]` and mobile shell colors.

## Testing Strategy

Unit tests:

- Normalize empty/partial/corrupt appearance objects.
- Patch nested values immutably.
- Map font choices to expected CSS variables.
- Map density/motion/contrast choices to expected root classes.
- Migrate legacy accent into `appearance.color.accent`.

DOM tests:

- Applying appearance updates root style variables and classes.
- Reset returns to `DEFAULT_APPEARANCE`.
- `setAccent` updates `appearance.color.accent`, not a separate state path.

Integration tests:

- Settings load hydrates `runtime.state.appearance`.
- Changing a control calls `/api/auth/settings` with the full `appearance` object.
- Persistence failure shows a toast but does not revert the visible setting.

Manual verification:

- Switch Bear Sans UI / Hanken / System and visually compare chat messages.
- Confirm code blocks and terminal stay MonoLisa by default.
- Confirm compact/spacious density changes chat and settings surfaces without layout overlap.
- Confirm high-contrast and reduced-motion are visible.
- Confirm refresh preserves choices.
- Confirm mobile PWA refresh picks up choices.

## Implementation Slices

1. Add pure appearance preference module and tests.
2. Add hydration/apply/persist flow in `live/settings.js`.
3. Replace the current Appearance card data with v1 controls.
4. Render new control row types in `surfaces.js`.
5. Wire actions and reset.
6. Add CSS variable/class coverage in `redesign.css` and mobile CSS.
7. Sync frontend, restart service, verify desktop and mobile.

## Deferred v2

- Named custom themes.
- Theme import/export JSON.
- Full per-token color editor.
- Palette/harmony generator.
- Derived syntax highlighting themes.
- Per-surface overrides, such as compact inbox but spacious chat.
- User-created font uploads.

## Open Questions

- Should light mode ship in v1 if it is not polished enough, or should v1 expose only Dark plus High Contrast?
- Should System Sans include the platform stack only, or also keep Inter as an explicit option if present in `frontend-vendor/fonts`?
- Should message width apply globally or only to chat prose while tables/code blocks keep wider max widths?
