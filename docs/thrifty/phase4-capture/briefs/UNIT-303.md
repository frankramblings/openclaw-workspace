# UNIT-303 — paste & drop into the upload pipeline

## Objective
Clipboard file paste and drag-drop land attachments through the existing
upload flow.

## Inputs / context
- CONTRACT.md upload-reuse (binding). `Composer.tsx` `upload(event)`
  (~line 73) — the refactor target; `attachments.ts` helpers unchanged.

## Approach
- Refactor: `uploadFiles(files: File[])` holding the current body of
  `upload`; the input onChange becomes a thin wrapper (clear input value,
  call uploadFiles).
- Paste: textarea onPaste — if `clipboardData.files.length`, preventDefault
  and uploadFiles(files). Text pastes unaffected (only intercept when files
  present).
- Drop: dragover/dragleave/drop on the composer container — visible
  drop-target class while a drag with files hovers (check
  `dataTransfer.types` includes 'Files'); drop → preventDefault +
  uploadFiles. Plain-text drags must not trigger the overlay.
- Styles: `.composer-drop-active` outline/tint per app palette.
- Tests: paste with files calls uploadFiles + preventDefault; paste with
  text-only does neither; drop uploads; text-drag doesn't activate state;
  input-change path still works (regression); a failed upload via paste path
  marks chips failed (reuse existing failure test pattern).

## Constraints
- Zero changes to attachments.ts or the send path. No new deps.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; counts reported and increased
- [ ] (assertional) exactly one upload code path (uploadFiles) serves all three entry points; text paste/drag behavior byte-identical to before

## Dependencies
none
