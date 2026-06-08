# Third-party assets bundled in the frontend

This directory vendors the SPA base plus a few prebuilt browser libraries and
fonts so the workspace runs without a build step or CDN. Each is redistributed
under its own license (all permissive). Trademarks/copyrights belong to their
respective owners.

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
