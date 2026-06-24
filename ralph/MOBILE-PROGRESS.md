# Mobile polish progress

2026-06-24 | tactile press feedback (small controls + composer + send-dim) | committed (was uncommitted)
2026-06-24 | large tap targets press-settle on :active (.m-mail, .m-grid-card, comp pill) | fixed
2026-06-24 | seeded ralph/MOBILE-POLISH.md backlog | done
2026-06-24 | screenshot survey of all 6 mobile surfaces; logged 3 new edges | found
2026-06-24 | chat empty/new-thread now shows .m-chat-zero prompt (was blank) | fixed
2026-06-24 | email list: drop dangling "·" when no snippet; active highlight on selection regardless of unread | fixed
2026-06-24 | DEPLOY GAP found: /static serves generated frontend/ (not overrides); ran sync-frontend.sh — iterations 1-2 now live & verified; protocol hardened w/ deploy+screenshot steps | fixed
2026-06-24 | root-caused top-of-list clipping to app.js atBottom stick-to-bottom applying to all .m-scroll (not just chat) | found
2026-06-24 | scope stick-to-bottom to chat thread + require real overflow; email/calendar now anchor at top, chat still sticks | fixed
2026-06-24 | a11y: :focus-visible teal ring (buttons/inputs) + reduced-motion guards (pulse/sheet-slide/blink; keep spinner) | fixed
2026-06-24 | built reusable harness.mjs to screenshot hash-unreachable surfaces (reader/sheets); verified 3 backlog items as non-bugs (tab-badge, quick-add +, reader border) | found
2026-06-24 | email reader: wire ✦ Summarize → summarizeEmail + inline .m-email-summary render + ✕ clear (verified via harness) | fixed
2026-06-24 | built mobile email compose sheet (renderComposeSheet) + wired reader AI reply/Draft/reply-box/send → composeAiDraft/composeReply/sendEmail (verified via harness) | fixed
2026-06-24 | REGRESSION (white screen on mobile): in-progress attach feature called map(s.pendingAttach) unguarded at mChat — when() evals args eagerly so falsy pendingAttach threw, blanking the app. Fixed mChat to map(...||[]) (matches desktop surfaces.js:195) AND hardened dom.js map() to be null-safe. Verified app loads, no console errors | fixed
2026-06-24 | reviewed the uncommitted attach/markdown/pull-to-refresh feature: data-upload change handler (app.js:290), removeAttach (chat.js:717), .m-attach-*/.m-md CSS all present & wired; harness screenshot confirms markdown (headings/list/inline-code/link) + attach chips render correctly. Only defect was the map crash (fixed). Feature still uncommitted (Frank's WIP) | verified
