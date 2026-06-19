# Third-party assets in frontend-overrides

These files vendor (or port) code from external projects with permissive
licenses. The synced `frontend/THIRD-PARTY.md` (base SPA libraries) is separate
— this file covers things layered on top by `frontend-overrides/`.

## OpenClaw Control UI (MIT)

Source: <https://github.com/openclaw/openclaw>
License: MIT — Copyright (c) 2026 OpenClaw Foundation
(See <https://github.com/openclaw/openclaw/blob/main/LICENSE> for full text.)

Files vendored or derived from OpenClaw:

| Local path | Upstream source | Adaptation |
|---|---|---|
| `data/openclaw-tool-display.json` | `apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json` | Copied verbatim (data only). |
| `openclaw-borrowed.css` | `ui/src/styles/chat/tool-cards.css` | Visual language ported; selectors adapted from `.chat-tool-card*` to Odysseus's `.agent-thread-node` markup. New drawer styles added. |
| `js/openclaw-inspector.js` | `ui/src/ui/tool-display.ts` + `ui/src/ui/chat/chat-sidebar-raw.ts` | Logic ported to vanilla JS. Resolver adapted for browser fetch of the JSON spec; "raw" sidebar pattern reused for the inspect drawer. |
| `js/usage-footer.js` | `ui/src/ui/format.ts` (`formatTokens`, `formatCost`) + `ui/src/ui/views/usage-metrics.ts` (`charsToTokens`) + `ui/src/styles/usage.css` (`.context-stacked-bar` fill visual) | Pure formatters ported to vanilla JS; progress-fill visual adapted into the `#hermes-footer` context bar. The usage query-language filter engine (`usage-helpers.ts`) was intentionally NOT ported. |

OpenClaw's MIT license notice is reproduced here:

> Copyright (c) 2026 OpenClaw Foundation
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.
