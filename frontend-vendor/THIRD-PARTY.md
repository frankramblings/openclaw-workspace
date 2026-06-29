# Third-party assets bundled in the frontend

This directory vendors the SPA base plus a few prebuilt browser libraries and
fonts so the workspace runs without a build step or CDN. Each is redistributed
under its own license. Trademarks/copyrights belong to their respective owners.

## SPA base

| Project | Author | License | Source |
|---|---|---|---|
| Odysseus | PewDiePie (Felix Kjellberg) | **AGPL-3.0-or-later** | https://github.com/pewdiepie-archdaemon/odysseus |

The vanilla-JS SPA in this directory (`app.js`, `js/`, `style.css`, the HTML
shells, etc.) is the Odysseus base, modified for this workspace. **Odysseus is
licensed AGPL-3.0-or-later — a strong network-copyleft license, not permissive.**
Because this project bundles and modifies AGPL-3.0 source and serves it over a
network, AGPL-3.0 §13 obliges offering the complete corresponding source of the
running version to its users, and a combined/distributed work must itself be
AGPL-3.0-compatible. The project is licensed accordingly — see the repo-root
`LICENSE` (AGPL-3.0) and `NOTICE`.

## Libraries (`lib/`)

| File | Project | License |
|---|---|---|
| `xlsx.full.min.js` | SheetJS (js-xlsx) | Apache-2.0 |
| `docx.umd.min.js` | docx | MIT |
| `mammoth.browser.min.js` | mammoth.js | BSD-2-Clause |
| `html2pdf.bundle.min.js` | html2pdf.js (+ jsPDF, html2canvas) | MIT |
| `highlight.min.js` | highlight.js | BSD-3-Clause |
| `qrcode.min.js` | qrcodejs | MIT |

## Fonts (`fonts/`)

| Font | License |
|---|---|
| Inter | SIL Open Font License 1.1 |
| Fira Code | SIL Open Font License 1.1 |
| GohuFont | WTFPL / public-domain-ish (see upstream) |

If you redistribute this project, keep this file alongside the assets. To refresh
a library, replace the file with the upstream minified build of the same name.

## hermes-webui (design reference)

The "Hermes" visual style (theme palettes, component shapes, workspace
explorer layout) is adapted from
[nesquena/hermes-webui](https://github.com/nesquena/hermes-webui)
(MIT License), commit `e8d71a2`. No source files are copied or imported at
runtime — palette values and layout conventions were adapted into
`frontend-overrides/hermes.css` and `frontend-overrides/js/theme.js`.
