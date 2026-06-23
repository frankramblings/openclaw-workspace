# Ralph progress log

2026-06-23 00:46 | seed inventory | verified — 186 old rows + 45 new rows written
2026-06-23 00:47 | index.html:23 <a tel:> | verified — [-] false positive (comment text); format-detection meta has parity (index-redesign.html:9)
2026-06-23 00:49 | index.html:377 close-memory-modal | verified [-] (modal->Settings Brain card); deferred finding: set-launcher buttons unwired (surfaces.js:479)
2026-06-23 00:49 | index.html:381 memory-tab browse | verified [-] (internal tab of removed memory-modal; no redesign sibling)
2026-06-23 00:50 | index.html:382 memory-tab skills | verified [-] (internal tab of removed memory-modal)
2026-06-23 00:50 | index.html:383 memory-tab add | verified [-] (internal tab of removed memory-modal)
2026-06-23 00:50 | index.html:384 memory-tab settings | verified [-] (internal tab of removed memory-modal)
2026-06-23 00:51 | index.html:403 memory-select-btn | verified [-] (memory-modal body toolbar; no redesign browse list)
2026-06-23 00:51 | index.html:404 memory-tidy-btn | verified [-] (memory-modal toolbar; no dedupe sibling)
2026-06-23 00:52 | index.html:408 memory-cat-chip | verified [-] (memory-modal browse filter; no redesign browse list)
2026-06-23 00:52 | index.html:414 memory-bulk-delete | verified [-] (memory-modal multi-select bar; no redesign equivalent)
2026-06-23 00:52 | index.html:415 memory-bulk-cancel | verified [-] (memory-modal multi-select bar)
2026-06-23 00:53 | index.html:427 memory-import-btn | verified [-] (memory-modal I/O; no redesign memory import)
2026-06-23 00:53 | index.html:428 memory-export-btn | verified [-] (memory-modal I/O; no redesign export). Noted modal spans :373-562.
2026-06-23 00:55 | index.html:463 add-skill-btn | verified [-] (memory-modal Skills tab; skills now data/skills files+Brain card). Broadened FINDINGS: all settings set-btn/set-launcher/Wipe buttons dead.
2026-06-23 00:56 | index.html:497 skills-select-btn | verified [-] (memory-modal Skills-tab toolbar; no bulk-select in redesign)
2026-06-23 00:56 | index.html:498 skills-audit-btn | verified [-] (memory-modal Skills tab; audit only in Brain-card subtext, no button)
2026-06-23 00:56 | index.html:506 skills-bulk-publish | verified [-] (memory-modal Skills-tab bulk bar)
2026-06-23 00:57 | index.html:507 skills-bulk-audit | verified [-] (memory-modal Skills-tab bulk bar)
2026-06-23 00:57 | index.html:508 skills-bulk-delete-nonpassing | verified [-] (memory-modal Skills-tab bulk bar)
2026-06-23 00:57 | index.html:509 skills-bulk-delete | verified [-] (memory-modal Skills-tab bulk bar; completes memory-modal cluster)
2026-06-23 00:57 | index.html:510 skills-bulk-cancel | verified [-] (final memory-modal element; cluster :377-510 complete)
2026-06-23 00:58 | index.html:567 theme-opacity-wrap | verified [-] (theme-popup Peek; redesign has only inline accents + dead launcher)
2026-06-23 00:58 | index.html:571 close-theme-popup | verified [-] (no theme popup in redesign)
2026-06-23 00:59 | index.html:575 theme-tab-browse | verified [-] (theme-popup internal tab; no preset browser in redesign)
2026-06-23 00:59 | index.html:576 theme-tab-customize | verified [-] (theme-popup tab; reduced to inline accent swatches)
2026-06-23 01:00 | index.html:596 Reset-this-color (Background, 1/18) | verified [-] (theme-popup per-color reset; redesign has single accent swatch only)
2026-06-23 01:00 | index.html:597 Reset-this-color (Text, 2/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:00 | index.html:598 Reset-this-color (Panel, 3/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:01 | index.html:599 Reset-this-color (Sidebar, 4/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:01 | index.html:600 Reset-this-color (Border, 5/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:01 | index.html:601 Reset-this-color (6/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:01 | index.html:611 Reset-this-color (7/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:02 | index.html:612 Reset-this-color (8/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:02 | index.html:613 Reset-this-color (9/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:02 | index.html:619 Reset-this-color (10/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:02 | index.html:620 Reset-this-color (11/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:03 | index.html:626 Reset-this-color (12/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:03 | index.html:627 Reset-this-color (13/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:03 | index.html:628 Reset-this-color (14/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:03 | index.html:629 Reset-this-color (15/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:04 | index.html:635 Reset-this-color (16/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:04 | index.html:636 Reset-this-color (17/18) | verified [-] (theme-popup per-color reset)
2026-06-23 01:04 | index.html:642 Reset-this-color (18/18) | verified [-] (theme-popup per-color reset; run :596-642 complete)
2026-06-23 01:05 | index.html:649 theme-adv-clear | verified [-] (advanced theme-popup override control; not ported)
2026-06-23 01:05 | index.html:681 harmony-generate-btn | verified [-] (theme-popup harmony generator; not ported)
2026-06-23 01:05 | index.html:769 Reset-to-text-color | verified [-] (theme-popup effect-color reset; not ported)
2026-06-23 01:06 | index.html:788 theme-save-go | verified [-] (theme-popup preset-save; no custom-theme save in redesign)
2026-06-23 01:06 | index.html:792 theme-import-btn | verified [-] (theme-popup JSON import; no theme-only import in redesign)
2026-06-23 01:06 | index.html:793 theme-export-btn | verified [-] (theme-popup JSON export; no theme-only export in redesign)
2026-06-23 01:06 | index.html:797 theme-import-go | verified [-] (theme-popup import Apply; not ported)
2026-06-23 01:07 | index.html:798 theme-import-cancel | verified [-] (theme-popup import Cancel; not ported)
2026-06-23 01:08 | index.html:801 theme-reset-btn | verified [-] (theme-popup Reset-to-Default; ends theme-modal cluster :563-801)
2026-06-23 01:08 | index.html:807 mobile-menu-btn | verified [-] (mobile nav replaced by bottom tab bar + More hub)
2026-06-23 01:09 | index.html:809 hamburger-btn | verified [x] parity OK -> toggleRail (app.js:62/66/126)
2026-06-23 01:09 | index.html:816 sidebar-toggle-btn | verified [x] parity OK -> toggleRail (same as :809)
2026-06-23 01:11 | index.html:825 rail-search-btn | verified [!] PARITY GAP — search decorative across redesign (oc-search x4, no input/handler/Ctrl-K). Logged FINDINGS + tracking row.
2026-06-23 01:11 | index.html:826 rail-new-session | verified [x] parity OK -> newChat (live/chat.js:295, surfaces.js:22)
2026-06-23 01:13 | index.html:827 rail-delete-session | verified [!] PARITY GAP — no session-delete affordance in redesign; logged FINDINGS (deferred)
2026-06-23 01:13 | index.html:830 rail-chats | verified [x] parity OK -> go:chat (app.js:68/52/127)
2026-06-23 01:14 | index.html:831 rail-documents | verified [x] parity OK -> Library surface + explorer documents/ (consolidated)
2026-06-23 01:14 | index.html:833 rail-calendar | verified [x] parity OK -> go:calendar (live/calendar.js)
2026-06-23 01:15 | index.html:834 rail-compare | verified [!] PARITY GAP — no Compare surface; only dangling settings-visibility label. Logged FINDINGS (sidebar list advertises nonexistent surfaces).
2026-06-23 01:15 | index.html:835 rail-cookbook | verified [!] PARITY GAP — no Cookbook surface (only sb-cookbook label); covered by existing FINDINGS
2026-06-23 01:16 | index.html:836 rail-research | verified [x] parity OK -> go:research (live/research.js)
2026-06-23 01:16 | index.html:837 rail-email | verified [x] parity OK -> go:email (live/email.js)
2026-06-23 01:17 | index.html:838 rail-gallery | verified [!] PARITY GAP — no Gallery browse surface (data persists via Wipe-gallery); covered by FINDINGS
2026-06-23 01:17 | index.html:839 rail-archive | verified [x] parity OK -> Library surface (title=Library/doclib; same as rail-documents)
2026-06-23 01:18 | index.html:840 rail-memory | verified [!] Brain relocated to Settings card but Open-Brain launcher dead (unreachable); covered by FINDINGS
2026-06-23 01:19 | index.html:841 rail-notes | verified [x] parity OK -> go:notes (live/notes.js)
2026-06-23 01:19 | index.html:842 rail-tasks | verified [!] PARITY GAP — no Tasks surface (Inbox is triage, not tasks); covered by FINDINGS
2026-06-23 01:20 | index.html:843 rail-theme | verified [x] parity OK (reduced) -> Settings accent swatches setAccent live-wired (live/settings.js:82); full picker dead (FINDINGS)
2026-06-23 01:21 | index.html:846 rail-settings | verified [x] parity OK -> go:settings (live/settings.js); surface nav wired (internal buttons dead per FINDINGS)
2026-06-23 01:22 | index.html:871 chats-library-btn | verified [!] PARITY GAP — no session-management view; logged consolidated FINDINGS for the :871-916 cluster
2026-06-23 01:22 | index.html:878 session-sort-btn | verified [!] PARITY GAP — no session sort; covered by session-management FINDINGS
2026-06-23 01:23 | index.html:898 auto-sort-sessions-more | verified [!] PARITY GAP — no auto-sort/tidy; covered by session-management FINDINGS
2026-06-23 01:23 | index.html:915 session-bulk-archive | verified [!] PARITY GAP — no bulk session archive; covered by session-management FINDINGS
2026-06-23 01:23 | index.html:916 session-bulk-delete | verified [!] PARITY GAP — no bulk session delete; session-mgmt cluster :871-916 complete
2026-06-23 01:24 | index.html:917 session-bulk-cancel | verified [!] PARITY GAP — session multi-select cancel; covered by session-management FINDINGS
2026-06-23 01:25 | index.html:955 email-compose-btn | verified [!] PARITY GAP — +New email dead (no data-act). Logged SYSTEMIC FINDINGS: ~16 per-surface action buttons unwired.
2026-06-23 01:26 | index.html:1036 library-new-doc-btn | verified [!] PARITY GAP — no New-document in redesign Library (read-only artifacts); plausibly intentional, deferred
2026-06-23 01:27 | index.html:1085 user-bar-settings | verified [-] redundant settings shortcut; settings reachable via rail-settings ([x])
2026-06-23 01:28 | index.html:1100 incognito-indicator | verified [!] PARITY GAP — no incognito mode; shortcuts card decorative (no kbd handlers). Logged FINDINGS.
2026-06-23 01:29 | index.html:1101 export-dl-btn | verified [!] PARITY GAP — no chat conversation-actions/More menu; logged cluster FINDINGS
2026-06-23 01:30 | index.html:1106 incognito-btn | verified [!] PARITY GAP — incognito toggle; same missing feature as :1100 (FINDINGS). Also fixed export-dl-btn note (export-* are <div>s, not rows).
2026-06-23 01:31 | index.html:1166 overflow-plus-btn | verified [x] parity (reimagined) -> "+" toggleSlash palette (surfaces.js:94); contents differ, child tools in :1173+
2026-06-23 01:32 | index.html:1173 overflow-attach-btn | verified [!] PARITY GAP — no composer file-attach; logged Chat Bar FINDINGS (advertises nonexistent tools)
2026-06-23 01:33 | index.html:1177 overflow-doc-btn | verified [!] composer doc-editor button gone; partial via Notes+/note,/split; Chat Bar FINDINGS
2026-06-23 01:33 | index.html:1183 overflow-rag-btn | verified [!] PARITY GAP — no RAG tool in redesign (vector store persists server-side); Chat Bar FINDINGS
2026-06-23 01:34 | index.html:1196 overflow-tts-btn | verified [-] old button already hidden(display:none) in baseline; no active feature; redesign has no TTS
2026-06-23 01:34 | index.html:1201 overflow-preset-btn | verified [!] PARITY GAP — no preset-picker UI (data persists); Chat Bar FINDINGS
2026-06-23 01:35 | index.html:1210 web-toggle-btn | verified [!] composer web-search toggle gone; capability via agent tools+/research; Chat Bar FINDINGS
2026-06-23 01:35 | index.html:1216 bash-toggle-btn | verified [!] composer shell toggle gone; capability via /run+Terminal; Chat Bar FINDINGS
2026-06-23 01:35 | index.html:1222 rag-indicator-btn | verified [!] PARITY GAP — no RAG UI (same as :1183); Chat Bar FINDINGS
2026-06-23 01:36 | index.html:1230 research-toggle-btn | verified [!] composer research toggle gone; strong replacement (Research surface + /research); Chat Bar FINDINGS
2026-06-23 01:37 | index.html:1236 group-toggle-btn | verified [!] PARITY GAP — Group Chat (multi-model) absent; sibling to Compare gap
2026-06-23 01:38 | index.html:1243 character-indicator-btn | verified [!] PARITY GAP — no character/persona feature; cb-chars label only; Chat Bar FINDINGS
2026-06-23 01:38 | index.html:1249 compare-indicator-btn | verified [!] PARITY GAP — no Compare feature (same as :834); FINDINGS
2026-06-23 01:39 | index.html:1263 model-picker-btn | verified [!] PARITY GAP — composer model-btn dead (no data-act); effort pill also dead. Logged FINDINGS.
2026-06-23 01:40 | index.html:1267 model-picker-add-models-btn | verified [!] partial — Added Models card is read-only display; no add control; dead-settings FINDINGS
2026-06-23 01:41 | index.html:1276 mode-agent-btn | verified [x] parity OK -> setMode (app.js:133) + mode sent to /api/chat_stream (chat.js:436). Caught truncated-grep false alarm.
2026-06-23 01:42 | index.html:1277 mode-chat-btn | verified [x] parity OK -> setMode chat (functional, same toggle as :1276)
2026-06-23 01:42 | index.html:1279 New-chat send-btn | verified [x] parity OK -> split into send + newChat (both wired)
2026-06-23 01:43 | index.html:1295 close-custom-preset | verified [-] custom-preset-modal chrome removed with unported preset feature (modal :1291-1468)
2026-06-23 01:43 | index.html:1300 preset-tab active | verified [-] removed custom-preset-modal sub-tab
2026-06-23 01:44 | index.html:1301 preset-tab | verified [-] removed custom-preset-modal sub-tab
2026-06-23 01:44 | index.html:1302 preset-tab | verified [-] removed custom-preset-modal sub-tab (3rd)
2026-06-23 01:45 | index.html:1333 char-new-btn | verified [-] character-builder control in removed preset modal (char feature unported)
2026-06-23 01:45 | index.html:1339 char-delete-template-btn | verified [-] character-builder control in removed preset modal
2026-06-23 01:45 | index.html:1340 reset-character-btn | verified [-] character-builder control in removed preset modal
2026-06-23 01:45 | index.html:1346 char-expand-btn | verified [-] character-builder control in removed preset modal
2026-06-23 01:46 | index.html:1355 group-mode-btn | verified [-] group-chat builder control in removed preset modal (group unported)
2026-06-23 01:46 | index.html:1361 group-add-btn | verified [-] group-builder control in removed preset modal
2026-06-23 01:47 | index.html:1367 cancel-custom-preset | verified [-] removed custom-preset-modal footer
2026-06-23 01:47 | index.html:1368 save-custom-preset | verified [-] removed custom-preset-modal footer; preset-modal cluster :1291-1368 done
2026-06-23 01:48 | index.html:1382 we-new-file | verified [!] PARITY GAP — explorer browse-only, no file mgmt; logged workspace-explorer FINDINGS
2026-06-23 01:48 | index.html:1383 we-new-folder | verified [!] PARITY GAP — no folder create; workspace-explorer FINDINGS
2026-06-23 01:48 | index.html:1384 we-upload | verified [!] PARITY GAP — no upload; workspace-explorer FINDINGS
2026-06-23 01:49 | index.html:1385 we-prefs | verified [!] PARITY GAP — no explorer prefs; workspace-explorer FINDINGS
2026-06-23 01:49 | index.html:1386 we-refresh | verified [!] PARITY GAP — no refresh; workspace-explorer FINDINGS
2026-06-23 01:50 | index.html:1387 we-collapse | verified [x] parity OK -> toggleComp Hide panel (companion.js:108/118)
2026-06-23 01:50 | index.html:1390 we-tab-files | verified [x] parity OK -> compTab files (companion.js:104)
2026-06-23 01:51 | index.html:1391 we-tab-artifacts | verified [-] Artifacts tab relocated to Library surface
2026-06-23 01:51 | index.html:1397 we-reopen | verified [x] parity OK -> toggleComp reveal (companion.js:118)
2026-06-23 01:52 | index.html:1398 scroll-bottom-btn | verified [!] minor PARITY GAP — no scroll-to-bottom in redesign; logged FINDINGS (low priority)
2026-06-23 01:53 | index.html:1473 close-rename-session | verified [-] rename-session-modal chrome removed with unported rename feature
2026-06-23 01:53 | index.html:1486 cancel-rename-session | verified [-] removed rename-session-modal footer
2026-06-23 01:53 | index.html:1487 save-session-name | verified [-] removed rename-session-modal footer; rename modal cluster done
2026-06-23 01:54 | index.html:1499 close-cookbook-modal | verified [-] cookbook-modal chrome removed with unported Cookbook feature
2026-06-23 01:54 | index.html:1510 settings-opacity-wrap | verified [-] settings-modal Peek toggle; redesign settings is a surface (no overlay)
2026-06-23 01:55 | index.html:1514 settings close-btn | verified [-] settings-modal chrome; settings is a surface now
2026-06-23 01:56 | index.html:1520 settings-nav-item services | verified [x] parity OK -> setSection services (surfaces.js:422)
2026-06-23 01:57 | index.html:1524 settings-nav-item ai | verified [x] parity OK -> setSection ai
2026-06-23 01:57 | index.html:1528 settings-nav-item search | verified [x] parity OK -> setSection search
2026-06-23 01:58 | index.html:1536 settings-nav-item integrations | verified [x] parity OK -> setSection integrations
2026-06-23 01:59 | index.html:1540 settings-nav-item email | verified [x] parity OK -> setSection email
2026-06-23 01:59 | index.html:1544 settings-nav-item reminders | verified [x] parity OK -> setSection reminders
2026-06-23 02:00 | index.html:1549 settings-nav-item brain | verified [x] parity OK -> setSection brain (old tabs map 1:1 to NAV_GROUPS)
2026-06-23 02:00 | index.html:1553 settings-nav-item scheduled | verified [x] parity OK -> setSection scheduled
2026-06-23 02:01 | index.html:1559 settings-nav-item appearance | verified [x] parity OK -> setSection appearance
2026-06-23 02:01 | index.html:1563 settings-nav-item shortcuts | verified [x] parity OK -> setSection shortcuts (nav works; shortcut content unwired per FINDINGS)
2026-06-23 02:02 | index.html:1569 settings-nav-item account | verified [x] parity OK -> setSection account
2026-06-23 02:02 | index.html:1575 settings-nav-item tools (admin) | verified [x] parity OK -> setSection tools (ADMIN group)
2026-06-23 02:03 | index.html:1579 settings-nav-item users (admin) | verified [x] parity OK -> setSection users (ADMIN)
2026-06-23 02:04 | index.html:1583 settings-nav-item system (admin) | verified [x] parity OK -> setSection system; settings category nav complete (14 tabs)
2026-06-23 02:06 | index.html:1606 set-defaultAddFallback | verified [!] dead set-add (+ add) on chips; dead-settings FINDINGS extended
2026-06-23 02:06 | index.html:1623 set-utilityAddFallback | verified [!] dead chips +add (same as :1606); dead-settings FINDINGS
2026-06-23 02:06 | index.html:1636 set-visionAddFallback | verified [!] dead chips +add (same as :1606); dead-settings FINDINGS
2026-06-23 02:07 | index.html:1767 set-ttsPreviewBtn | verified [-] TTS not ported (no TTS settings; consistent with vestigial composer TTS :1196)
2026-06-23 02:08 | index.html:1800 search-provider-btn | verified [!] provider/select rows display-only; dead-settings FINDINGS extended
2026-06-23 02:09 | index.html:1816 set-searchTestBtn | verified [!] dead set-btn Test; dead-settings FINDINGS
2026-06-23 02:09 | index.html:1855 settings-open-brain | verified [!] dead Open-Brain launcher (set-launcher); FINDINGS
2026-06-23 02:10 | index.html:1862 settings-open-cron | verified [!] dead Open-Scheduled launcher (set-launcher); FINDINGS
2026-06-23 02:10 | index.html:1869 settings-open-theme | verified [!] dead Open-theme-picker launcher (set-launcher); FINDINGS
2026-06-23 02:11 | index.html:2047 set-uiVisResetBtn | verified [!] minor — no reset-all-visibility (toggleUi toggles themselves wired)
2026-06-23 02:11 | index.html:2061 shortcuts-reset-btn | verified [!] no shortcut customization/reset (shortcuts decorative); shortcuts FINDINGS
2026-06-23 02:12 | index.html:2079 settings-logout-btn | verified [!] NOTABLE — Logout button dead (no data-act); cannot sign out. Flagged high-priority in FINDINGS.
2026-06-23 02:12 | index.html:2093 settings-pw-save | verified [!] NOTABLE — Update Password dead; cannot change password. FINDINGS (high-priority).
2026-06-23 02:12 | index.html:2111 set-email-open-integrations | verified [!] dead "Manage in Integrations" set-btn; dead-settings FINDINGS
2026-06-23 02:13 | index.html:2119 set-email-open-tasks | verified [!] dead "Open Tasks" set-btn + no Tasks surface; FINDINGS
2026-06-23 02:13 | index.html:2130 set-email-style-extract | verified [!] dead Writing-Style Extract btn; dead-settings FINDINGS
2026-06-23 02:14 | index.html:2131 set-email-style-save | verified [!] dead Writing-Style Save btn; dead-settings FINDINGS
2026-06-23 02:15 | index.html:2164 set-reminders-open-integrations | verified [!] minor — no Integrations cross-link in redesign reminders
2026-06-23 02:15 | index.html:2187 set-reminder-test-btn | verified [!] dead reminders Test btn; dead-settings FINDINGS
2026-06-23 02:15 | index.html:2216 adm-addBtn | verified [!] dead Add-User btn; dead-settings FINDINGS
2026-06-23 02:16 | index.html:2230 adm-ep accordion toggle | verified [-] accordion layout not ported (flat cards in redesign)
2026-06-23 02:16 | index.html:2245 adm-epLocalTestBtn | verified [!] no endpoint Test in redesign (read-only Added Models); dead-settings FINDINGS
2026-06-23 02:17 | index.html:2246 adm-epLocalAddBtn | verified [!] no add-endpoint in redesign; dead-settings FINDINGS
2026-06-23 02:17 | index.html:2249 adm accordion toggle | verified [-] accordion layout not ported (same as :2230)
2026-06-23 02:17 | index.html:2254 adm-epDiscoverBtn | verified [!] no endpoint discovery in redesign; FINDINGS
2026-06-23 02:18 | index.html:2257 adm-epOllamaBtn | verified [!] no endpoint connect in redesign (Ollama listed read-only); FINDINGS
2026-06-23 02:19 | index.html:2266 adm accordion toggle | verified [-] accordion layout not ported
2026-06-23 02:19 | index.html:2277 adm-provider-btn | verified [!] dead provider selector; dead-settings FINDINGS
2026-06-23 02:19 | index.html:2304 adm-epApiTestBtn | verified [!] no API endpoint test in redesign; FINDINGS
2026-06-23 02:19 | index.html:2305 adm-epApiCancelTestBtn | verified [!] no endpoint test flow in redesign; FINDINGS
2026-06-23 02:20 | index.html:2306 adm-epAddBtn | verified [!] no add-API-endpoint in redesign; FINDINGS
2026-06-23 02:20 | index.html:2341 unified-intg-add-btn | verified [!] dead "+ Add Integration" set-btn; dead-settings FINDINGS
2026-06-23 02:21 | index.html:2362 adm-exportDataBtn | verified [!] dead Export Data set-btn; dead-settings FINDINGS
2026-06-23 02:21 | index.html:2363 adm-importDataBtn | verified [!] dead Import Data set-btn; dead-settings FINDINGS
2026-06-23 02:21 | index.html:2377 admin-btn-delete (Wipe all chats, 1/8) | verified [!] dead Wipe danger btn; dead-settings FINDINGS (high-pri)
2026-06-23 02:22 | index.html:2385 admin-btn-delete (Wipe all memory, 2/8) | verified [!] dead Wipe danger btn; FINDINGS
2026-06-23 02:22 | index.html:2393 admin-btn-delete (Wipe all skills, 3/8) | verified [!] dead Wipe danger btn; FINDINGS
2026-06-23 02:23 | index.html:2401 admin-btn-delete (Wipe all notes, 4/8) | verified [!] dead Wipe danger btn; FINDINGS
2026-06-23 02:23 | index.html:2409 admin-btn-delete (Wipe all tasks, 5/8) | verified [!] dead Wipe danger btn; FINDINGS
2026-06-23 02:23 | index.html:2417 admin-btn-delete (Wipe all documents, 6/8) | verified [!] dead Wipe danger btn; FINDINGS
2026-06-23 02:23 | index.html:2425 admin-btn-delete (Wipe all gallery, 7/8) | verified [!] dead Wipe danger btn; FINDINGS
2026-06-23 02:24 | index.html:2433 admin-btn-delete (Wipe all calendar, 8/8) | verified [!] dead Wipe danger btn; 8 wipe buttons done
2026-06-23 02:24 | new-wiring data-act=clearQuick | verified [x] WIRED -> live calendar.js:310 (quick-parse + create event)
2026-06-23 02:25 | new-wiring data-act=closeCapture | verified [x] WIRED (mobile-app.js:62); but Send-to-Gary mis-wired to closeCapture -> capture discarded. Logged FINDINGS.
2026-06-23 02:26 | new-wiring data-act=closeCompanion | verified [x] WIRED -> mobile-app.js:59
2026-06-23 02:26 | new-wiring data-act=compTab | verified [x] WIRED -> app.js:141 (switch companion tab)
2026-06-23 02:26 | new-wiring data-act=companionTab | verified [x] WIRED -> mobile-app.js:60
2026-06-23 02:27 | new-wiring data-act=dismiss | verified [x] WIRED -> live inbox.js:92 (POST /api/items/action)
2026-06-23 02:27 | new-wiring data-act=go | verified [x] WIRED -> app.js:127 (primary surface nav)
2026-06-23 02:28 | new-wiring data-act=libFilter | verified [x] WIRED -> app.js:162 + filters list (surfaces.js:341)
2026-06-23 02:28 | new-wiring data-act=mBackToHub | verified [x] WIRED -> mobile-app.js:55
2026-06-23 02:29 | new-wiring data-act=mCloseReader | verified [x] WIRED -> mobile-app.js:57
2026-06-23 02:29 | new-wiring data-act=mGo | verified [x] WIRED -> mobile-app.js:49 (mobile tab nav)
2026-06-23 02:29 | new-wiring data-act=mOpenReader | verified [x] WIRED -> live email.js:178 (openAt loads message)
2026-06-23 02:30 | new-wiring data-act=mOpenSub | verified [x] WIRED -> mobile-app.js:50 (push sub-surface)
2026-06-23 02:30 | new-wiring data-act=newChat | verified [x] WIRED -> live chat.js:295 (same as rail-new-session)
2026-06-23 02:31 | new-wiring data-act=openCapture | verified [x] WIRED -> mobile-app.js:61 (opens capture sheet)
2026-06-23 02:31 | new-wiring data-act=openCompanion | verified [x] WIRED -> mobile-app.js:58
2026-06-23 02:32 | new-wiring data-act=pickResOpt | verified [x] WIRED -> app.js:148 (sets resCfg)
2026-06-23 02:32 | new-wiring data-act=pickSlash | verified [x] WIRED -> app.js:132 (insert slash cmd into draft)
2026-06-23 02:33 | new-wiring data-act=resDiscuss | verified [!] UNWIRED — no resDiscuss handler (orphaned data-act). Logged FINDINGS.
2026-06-23 02:34 | new-wiring data-act=resReport | verified [!] UNWIRED — no resReport handler (orphaned data-act, sibling of resDiscuss); FINDINGS
2026-06-23 02:34 | new-wiring data-act=resetResearch | verified [x] WIRED -> live research.js:174 (cancel + reset)
2026-06-23 02:34 | new-wiring data-act=selDoc | verified [x] WIRED -> app.js:163 (select note/doc)
2026-06-23 02:35 | new-wiring data-act=selEmail | verified [x] WIRED -> live email.js:176 (openAt loads message)
2026-06-23 02:35 | new-wiring data-act=selectSession | verified [x] WIRED -> live chat.js:264 (loads session thread)
2026-06-23 02:36 | new-wiring data-act=send | verified [x] WIRED -> live chat.js:309 (POST /api/chat_stream + activity trail)
2026-06-23 02:36 | new-wiring data-act=setAccent | verified [x] WIRED -> live settings.js:82 (real accent + persist)
2026-06-23 02:37 | new-wiring data-act=setCaptureType | verified [x] WIRED -> mobile-app.js:63
2026-06-23 02:37 | new-wiring data-act=setMode | verified [x] WIRED -> app.js:133 (mode reaches backend, verified :1276)
2026-06-23 02:37 | new-wiring data-act=setSection | verified [x] WIRED -> app.js:177 (settings section nav)
2026-06-23 02:38 | new-wiring data-act=startResearch | verified [x] WIRED -> live research.js:122 (POST /api/research/start)
2026-06-23 02:38 | new-wiring data-act=stopRun | verified [x] WIRED -> live chat.js:441 (abort stream)
2026-06-23 02:39 | new-wiring data-act=toggleComp | verified [x] WIRED -> app.js:143
2026-06-23 02:39 | new-wiring data-act=toggleFs | verified [x] WIRED -> app.js:144 (expand/collapse folder)
2026-06-23 02:40 | new-wiring data-act=toggleRail | verified [x] WIRED -> app.js:126 (verified at hamburger-btn)
2026-06-23 02:40 | new-wiring data-act=toggleResCtl | verified [x] WIRED -> app.js:147
2026-06-23 02:40 | new-wiring data-act=toggleSlash | verified [x] WIRED -> app.js:131
