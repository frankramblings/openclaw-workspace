# Perf / Glitch / Polish Batch — Design

**Date:** 2026-06-12
**Status:** Approved design (autonomous review batch), pending implementation plan
**Scope:** openclaw-workspace only (backend `documents.py`/`notes.py`/`calendar_google.py` + `frontend-overrides/` SPA). No gateway changes. Deploy = `./scripts/sync-frontend.sh` for frontend; backend changes go live on the next uvicorn restart (NOT performed repeatedly — 2014-mini constraint).

## Background

Full code review (4 parallel review passes: backend perf, frontend perf, UI glitches, polish) on 2026-06-12. Findings were individually verified against the code; the following review claims were checked and **rejected** (do not re-find):

- Calendar per-calendar event fetch "sequential" — FALSE, already `asyncio.gather` (calendar_google.py:129).
- Asana `_pat()` "re-parses .env per call" — FALSE, cached in `_token` global.
- document.js tab-bar scroll listener "accumulates" — FALSE, `tabBar.innerHTML` rebuild discards the old node and its listeners.
- document.js export error "raw alert()" — FALSE, `uiModule.showError` is the primary path; alert is a last-resort fallback.
- hljs "re-highlights already-highlighted blocks" — moot; each render replaces innerHTML so all nodes are fresh. The fix is render coalescing (P1), not highlight flags.
- Deferred consciously (low leverage / restart-cycle acceptable for a single-user box): skills/_USER_MAP cache TTLs, research `_JOBS` subscriber-leak edge, email style-extract N+1 (rare path), inbox provider-error message mapping, timestamp-format unification, icon-button title sweep, modal focus traps.

## Items

### P1 — Coalesce streaming renders (chat.js) [perf, biggest win]

**Problem:** Every SSE text delta calls `_renderStream()` directly (chat.js:1649). Each call re-parses the FULL accumulated round text through `markdownModule.processWithThinking` (O(n²) over the stream), builds an offscreen measure div and reads `offsetHeight` (forced reflow), swaps `innerHTML`, and re-runs hljs over every code block. On the 2014-mini/phone this is visible lag on long replies.

**Fix:** Add a `_queueRenderStream()` helper next to the `_renderStream` assignment (after chat.js:1242) that coalesces renders to one per animation frame:

```js
let _renderQueued = false;
const _queueRenderStream = () => {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => {
    _renderQueued = false;
    // A queued render may fire after the round was finalized (tool_start),
    // after the stream completed (final layout already painted), or after
    // agent_step reset the round — in all three cases rendering would stomp
    // newer DOM. Skip.
    if (roundFinalized || _streamSawDone || !roundText) return;
    _renderStream();
  });
};
```

Replace ONLY the per-delta hot-path call (the "Normal streaming" branch, line 1649) with `_queueRenderStream()`. All structural call sites (think-close 1645, think-removal 1597, tool_start 1962, agent_step 2218, stream-end 2331) stay synchronous — they need the DOM rendered before the next statement.

**Why safe:** `_renderStream` is idempotent over the latest `roundText`; rAF fires before next paint so visual latency is unchanged; the three-flag guard covers every reset path (`roundFinalized` set sync in tool_start before any yield; `_streamSawDone` set on the done frame; `roundText` emptied by agent_step/teacher_takeover).

### P2 — Visibility-guard tool tickers (chat.js) [perf]

**Problem:** Each running tool node gets two 250ms `setInterval`s — wave animation (chat.js:2032) and elapsed counter (chat.js:2041) — that keep doing DOM queries/writes when the tab is hidden (8 DOM ops/sec per tool, phone battery + background CPU).

**Fix:** First line of each interval callback: `if (document.hidden) return;`. Clearing logic untouched (intervals still cleared at tool_output/stop/error sweep).

### P3 — Unblock the event loop on vault scans (documents.py, notes.py) [perf]

**Problem:** `library()` (documents.py:148) and `list_notes()` (notes.py:62) do synchronous `glob` + full-file reads of every entry inside `async def` routes — blocking uvicorn's event loop for the whole scan on a slow disk. `list_session_docs()` (documents.py:195) has the same scan. While one of these runs, every other request (including chat SSE relay) stalls.

**Fix:** Extract each route's scan loop into a sync helper and call it via `await asyncio.to_thread(...)`. Filtering/sorting/pagination stays where it is (cheap, in-route). No response-shape change; existing route tests must stay green.

### P4 — Reuse one HTTP client for Google Calendar; don't refresh tokens on the loop (calendar_google.py) [perf]

**Problem:** `_get`/`_post` open a fresh `httpx.AsyncClient` (new TCP+TLS handshake) per API call (calendar_google.py:36-47); the events endpoint fans out to ~7 calendars = 8 handshakes per view. `_auth()` calls `google_auth.access_token()`, which on token expiry does a **sync** httpx POST (google_auth.py:36) on the event loop (up to 25s timeout).

**Fix:** Module-level lazily-created shared `httpx.AsyncClient` (recreate if closed); `headers=await asyncio.to_thread(_auth)` in `_get`/`_post`. No shape changes.

### G1 — Elapsed mm:ss timer survives spinner swaps (chat.js) [glitch, known cosmetic #1]

**Problem:** The turn clock `_elapsedSpan` is appended to the FIRST spinner (chat.js:866). `agent_step` destroys that spinner and creates a new one (chat.js:2247-2252) without the span; the ticker's guard (chat.js:868) re-validates against the reassigned `spinner` variable, so depending on tick timing it either keeps updating a detached span (invisible) or self-clears and the clock is gone for rounds 2+.

**Fix:** Make the ticker self-healing instead of self-clearing:

```js
const _turnTicker = setInterval(() => {
  if (!spinner || !spinner.element || !spinner.element.isConnected) return; // idle while text streams
  if (_elapsedSpan.parentElement !== spinner.element) spinner.element.appendChild(_elapsedSpan);
  _elapsedSpan.textContent = _fmtElapsed(Date.now() - _turnStart);
}, 1000);
```

Add `clearInterval(_turnTicker)` to the turn's `finally` (chat.js:2768 block — same closure scope). Update the now-wrong "self-guarding, no teardown wiring" comment (chat.js:854-857).

### G2 — Stall caption stops duplicating the clock (chat.js) [glitch, known cosmetic #2]

**Problem:** The stall label embeds `(m:ss total)` (chat.js:1929-1931) while `_elapsedSpan` shows the same m:ss beside it — doubled elapsed display (G1 makes the span reliably present, so the duplication would become constant).

**Fix:** Label becomes `'Still waiting — no activity for Ns'`. The span is the single elapsed display. (The agent-dots spinner path loses the total readout; `silent_for` still conveys staleness there.)

### X1 — Confirm before single-session delete (sessions.js) [polish]

**Problem:** Context-menu Delete (sessions.js:650) removes a session immediately — optimistic UI removal + fire-and-forget DELETE (which also deletes the gateway transcript). Bulk delete, folder delete, and archive-delete all use `styledConfirm`; single delete is the only unguarded destructive path, and there is no undo/restore.

**Fix:** First line of the delete handler (after the is_important guard):
`if (!await uiModule.styledConfirm(\`Delete "${s.name || 'this session'}"? This cannot be undone.\`, { confirmText: 'Delete', danger: true })) return;`
(keep `dropdown.style.display = 'none'` before the await so the menu doesn't linger under the dialog).

### X2 — Honest import results (chat.js) [polish + latent bug]

**Problem:** The file-import banner counts an import as successful without checking `res.ok` (chat.js:686-691 — a 4xx/5xx counts as imported), and failures only go to console; the banner always says "Imported N files".

**Fix:** `const res = await fetch(...); if (!res.ok) throw new Error('HTTP ' + res.status);` inside the existing try; count failures in the catch; banner text becomes `Imported ${imported} of ${total} file(s)` + ` (${failed} failed)` when `failed > 0`, and the auto-remove timeout extends to 4s when something failed.

## Verification

- Backend: `pytest` (full suite, 253+ tests) — no new endpoints, shapes unchanged; P3/P4 are mechanical async wraps.
- Frontend: `node --check` on every touched JS file; `./scripts/sync-frontend.sh` (auto-stamps sw.js CACHE_NAME); curl the served bytes to confirm the override landed. NO headless Chrome (host rule). User eyeballs for the stall/elapsed-timer behavior (rehearsable with `WORKSPACE_STALL_NOTICE=5` per the watchdog memo).
- Backend changes are inert until the next `launchctl kickstart -k gui/$(id -u)/ai.openclaw.workspace` — do at most ONE restart at the end, or leave to the user if the box is under load.

## Addendum (found during execution)

**Test runs were polluting the live sessions store.** `backend/tests` route tests (inbox spinoff et al.) called the real `sessions_store` — every pytest run wrote real session records into `.data/sessions.json`. 100 junk sessions named `Reply:/Inbox: Q about quotas` (the pytest fixture title) accumulated in the user's actual sidebar, and the leftovers are what made `test_spinoff_reply_intent_seeds_draft` fail (the 24h dedupe found a "recent" junk session and skipped seeding). It is also plausibly the real identity of the 2026-06-11 "runaway client that created ~100 'Reply:' sessions". Fixed with an autouse conftest fixture isolating `sessions_store._STORE_FILE` + `config.DATA_DIR` per-test. **Live-store cleanup of the 100 junk records is left to the user** (autonomous deletion of live data was declined by policy):

```bash
cd /Users/admin/openclaw-workspace && cp .data/sessions.json .data/sessions.json.bak && .venv/bin/python -c "
import json, os
d = json.load(open('.data/sessions.json'))
junk = {'Reply: Q about quotas', 'Inbox: Q about quotas'}
n = len(d['sessions']); d['sessions'] = [s for s in d['sessions'] if (s.get('name') or '') not in junk]
tmp = '.data/sessions.json.tmp'; json.dump(d, open(tmp, 'w'), indent=2); os.replace(tmp, '.data/sessions.json')
print('removed', n - len(d['sessions']))"
```

## Out of scope

The uncommitted UI-size/chat-text-size work in the working tree (index.html, theme.js, hermes.css, test_inbox_router.py) belongs to another session — leave untouched, don't commit it with this batch.
