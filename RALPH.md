# RALPH: Redesign Parity + Wiring Audit

You are auditing the redesign of the OpenClaw Workspace PWA frontend for two things:

1. **Parity** — every interactive feature in the OLD design has a sibling in the NEW design (or is intentionally removed with a reason).
2. **Wiring** — every clickable thing in the NEW design (buttons, links, menu items, icon buttons, form submits, keyboard shortcuts, `data-action` handlers) actually goes somewhere real — no dead `href="#"`, no empty `onClick`, no orphaned `data-action` strings, no `TODO`/`console.log`-only handlers.

## Repo facts (already verified — do not re-litigate)

- Repo root: `/home/frank/openclaw-workspace` (you are here).
- Branch: `redesign/direction-a-refined-charcoal`. Old design lives **side-by-side on this branch** — do NOT check out `main`.
- Stack: plain ES6 modules + HTML/CSS (no React/Vue/Svelte/bundler). Wiring = `addEventListener` calls, `onclick=` attrs, `data-action="…"` strings dispatched in JS, and `<a href="…">` anchors. No router framework.

### Old design surface (the baseline)
- `frontend/index.html` (2511 lines, ~187 interactive elements)
- `frontend/js/*.js` (the non-`redesign/` modules — `app.js`, `assistant.js`, `tasks.js`, `settings.js`, `theme.js`, `hermes-panels.js`, `activity-tree.js`, `modelPicker.js`, `emailInbox.js`, `search.js`, `tileManager.js`, `usage-footer.js`, `workspace-terminal-layout.js`, etc.)

### New design surface (must match it)
- `frontend/index-redesign.html` (thin shell — UI is JS-built)
- `frontend/js/redesign/**/*.js` (`app.js`, `companion.js`, `surfaces.js`, `dom.js`, `chat-activity.js`, `icons.js`, `data.js`, `settings-data.js`, plus `live/` and `mobile/` subdirs)
- `frontend/redesign.css`, `frontend/redesign-assets/`

## State files (source of truth — read first, write after every item)

- `ralph/INVENTORY.md` — checklist of every old-design interactive element + every new-design clickable. Status per row: `[ ]` pending, `[x]` verified wired/parity-ok, `[!]` issue found, `[-]` intentionally removed (with reason).
- `ralph/FINDINGS.md` — append-only log of issues: missing parity, dead links, unwired buttons, no-op handlers. One bullet per issue with `file:line` and the fix made (or `deferred — needs human`).
- `ralph/PROGRESS.md` — one line per iteration: `YYYY-MM-DD HH:MM | <row> | fixed|verified|deferred`.

## Loop protocol (do EXACTLY this each iteration — one item, then exit)

1. **Read state.** Read all three files in `ralph/`. If `INVENTORY.md` does not exist, this is iteration 1 → go to step 2. Otherwise → step 3.

2. **Build the inventory (iteration 1 only).**
   - **OLD inventory** — from `frontend/index.html` extract every `<button>`, `<a>`, `[role="button"]`, `onclick=`, `data-action=`, `data-tab=`, and `id` that's targeted by a `getElementById(...).addEventListener` in the legacy `frontend/js/*.js` modules. Use grep, not eyeballs.
   - **NEW inventory** — from `frontend/js/redesign/**/*.js` and `frontend/index-redesign.html` extract every element creation (`createElement('button')`, `innerHTML` with `<button|<a`, template strings with `data-action`) and every `addEventListener` / `on:` binding.
   - Write `ralph/INVENTORY.md` with two sections:
     - `## Old → New parity` — one row per OLD interactive element, `[ ] <label or selector> — <old-file:line>`.
     - `## New → wiring` — one row per NEW clickable, `[ ] <label or selector> — <new-file:line>`.
   - Commit: `ralph: seed inventory`. **Stop.** (Next iteration starts work.)

3. **Pick ONE pending item.** First `[ ]` row in `INVENTORY.md`, in file order. Do not batch. Do not skip ahead.

4. **Investigate the single item.**
   - **Parity row:** open the old reference at that `file:line`. Search the redesign modules for a sibling (same label, same `data-action`, same purpose). If found → `[x]` with a note pointing at the new `file:line`. If intentionally cut (e.g. feature replaced by something larger) → `[-]` with one-line reason. If genuinely missing → `[!]` and log to `FINDINGS.md`.
   - **Wiring row:** trace the handler. Wired = there is a real `addEventListener` (or `data-action` dispatched in a switch/map) that calls a defined function that does real work. Unwired = `() => {}`, `href="#"` with no JS handler, `data-action="foo"` with no `case 'foo':`, calls an undefined identifier, logs only, or routes to a path no other code defines. If wired → `[x]`. If not → `[!]` and log to `FINDINGS.md`.

5. **Fix if trivial, else defer.**
   - **Trivial** = the target handler/route already exists and just isn't bound, OR the missing element is a one-to-one port from old to new with no new design decisions. Apply the fix. Run no servers — static only.
   - **Non-trivial** (ambiguous intent, missing backend call, requires a design decision, would touch >50 lines, or would require reading >5 files to understand) → leave `[!]`, write a precise `needs human:` note in `FINDINGS.md` describing exactly what decision is missing, and move on.

6. **Update state and commit.**
   - Update the row in `INVENTORY.md`.
   - Append one line to `PROGRESS.md`.
   - `git add -A && git commit -m "ralph: <one-line>"`. Never amend. Never push. Never force.

7. **Stop the iteration.** Do not pick a second item. Exit cleanly.

## Done condition

If step 3 finds zero `[ ]` rows: append `DONE` as the final line of `PROGRESS.md`, commit, and exit. The outer shell loop will see `DONE` (or just keep looping harmlessly).

## Hard rules

- **One item per iteration.** No batching even if two look related.
- **Never check out `main`** or any other branch. Old design is already in the working tree on this branch.
- **Never delete an old-design element from the inventory** to "resolve" it. Mark `[-]` with a reason.
- **Never wire a button to a stub** just to make it `[x]`. If the real target doesn't exist, defer with `[!]`.
- **No new dependencies.** No refactors beyond the one wiring/parity fix. No CSS rewrites. No "while I'm here" cleanups.
- **Don't run the dev server / don't `systemctl restart`.** Static analysis only; Frank verifies in browser after.
- **Don't push.** Local commits only.
- **If a fix would touch >50 lines or >3 files, defer.**
- **Treat `frontend-overrides/` as the deployed snapshot, not source.** Audit `frontend/`. Mention in `FINDINGS.md` if a fix will also need `scripts/sync-frontend.sh` to be re-run by Frank.


- **Both designs live on the same branch** — old (`index.html` + legacy `js/*.js`) and new (`index-redesign.html` + `js/redesign/**`) coexist. Prompt tells the loop NOT to check out `main`.
- **Stack confirmed:** plain ES6 modules, no router/bundler. Wiring = `addEventListener` + `data-action` + raw `<a href>`. Inventory step uses grep over those exact patterns.
- **Old surface is 2511-line HTML with ~187 interactive elements** — chunky inventory. The state-file discipline matters; without it the loop will lose its place.
- **`frontend-overrides/` is the deployed copy**, not source — flagged so the loop audits `frontend/` only and reminds you to run `sync-frontend.sh` after.

**Outer loop to run overnight** (paste in the attached terminal):

```bash
cd ~/openclaw-workspace && for i in $(seq 1 200); do
  echo "=== iter $i $(date -Is) ===" >> ralph/loop.log
  claude -p "$(cat RALPH.md)" --dangerously-skip-permissions >> ralph/loop.log 2>&1 || break
  grep -q '^DONE$' ralph/PROGRESS.md 2>/dev/null && { echo "DONE"; break; }
  sleep 3
done
```

That caps at 200 iterations as a safety net, logs each run to `ralph/loop.log`, and exits clean if `PROGRESS.md` ends with `DONE` or Claude errors out hard.

**Before you let it rip — two sanity moves:**
1. `mkdir -p ralph` (the prompt assumes it exists; loop will create it on iter 1 either way, but pre-creating is cleaner).
2. Make sure your working tree is clean and pushed *before* starting — every iteration commits, so if you decide overnight went sideways, `git reset --hard <pre-ralph-sha>` is your eject button.


Begin.
