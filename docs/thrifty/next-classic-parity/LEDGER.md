# next-classic-parity — thrifty ledger (2026-07-21)

Spec: `docs/superpowers/specs/2026-07-21-next-classic-parity-design.md` (approved; hybrid shell).

## Substrate note
`thrifty-dispatch` could not run on this box — `claude -p --bare` returns
"Not logged in" (no CLI OAuth headless). Fell back to the subagent substrate:
same contract + briefs, 5 Haiku executor subagents in parallel. Artifacts here
(contract.md, sprints.jsonl, build_sprints.py, manifest.json from the failed
dispatch attempt) are the run's plan of record.

## Sprints (all Haiku, all delivered first-try)
| id | file | result |
|---|---|---|
| SPRINT-THEME | src/lib/theme.ts (225 ln) | ✅ faithful; normalize precedence differs from contract letter (top-level before colors) but agrees on real data |
| SPRINT-FX | src/lib/constellations.ts (167 ln) | ✅ |
| SPRINT-ICONS | src/kit/icons.tsx (319 ln) | ✅ byte-verbatim bodies; orchestrator later added `warning` + `mic` |
| SPRINT-THEME-TEST | src/lib/theme.test.ts (9 tests) | ✅ all pass |
| SPRINT-ICONS-TEST | src/kit/icons.test.tsx (7 tests) | ✅ all pass |

## Orchestrator (surgical) work
tokens.css rewrite (classic :root verbatim + legacy --acc aliases), app.css
rule-level revert of the 16 drifted Sonoma rules + message-layer restyle onto
/next DOM, shell.css chrome restyle (top bar/dock/rail/composer card, traffic
lights CSS removed), TopBar/Dock/registry icon swap, ChatWelcome (classic
chat-welcome + fill-composer chips), Modal/SessionList/Composer glyph swaps,
initTheme boot wiring, shell.test.tsx updated for duplicate agent-name (welcome
+ brand — intentional).

## Gate
- tsc clean; `npm run build` clean; main bundle 115.2KB gz (≤116 budget);
  constellations = lazy chunk.
- vitest 330: 328 pass; 2 fails = pre-existing composer pair (verified failing
  on HEAD via stash before any changes).
- Screenshot pairs (desktop 1440×900 + mobile 390×844) under
  /home/frank/ralph-shots/parity/; stage `#07131f` and rail `#0e2748`
  pixel-identical to classic under the fortress theme.

## Discoveries recorded in the spec
- Classic look = redesign.css + runtime "fortress" custom theme from
  /api/prefs/theme + accent from /api/config (NOT /api/prefs/accent).
- Redesign shell consumes NONE of the advanced (--user-bubble-bg…) or --hl-*
  vars → theme.ts ports core 5 + accent + bg-effect vars only.
- `theme-frosted` styling exists only for classic-gateway selectors → /next
  toggles the body class but defines no frosted CSS (parity = no visible effect).

## Known residuals
- Headless captures show brand/welcome name as "…" (config Remote unresolved at
  capture time) — pre-existing, also visible in pre-parity screenshots.
- 2 pre-existing composer test fails (out of scope, tracked in chat-ux memory).
- 📎/★ content-level glyphs in email/notes/message attachments kept (content,
  not chrome).
