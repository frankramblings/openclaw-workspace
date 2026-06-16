# Terminal image drop / paste — design

**Date:** 2026-06-16
**Status:** approved design, pre-implementation
**Surface:** openclaw-workspace (FastAPI backend + Hermes terminal overlay)

## Summary

Let the user drop or paste an image directly onto the per-chat terminal panel.
The image is saved (reusing the existing chat-upload pipeline, so it lands in
Gary's vault), a `[name.ext]` token is typed at the terminal cursor as a visible
marker, the in-terminal CLI can resolve that token to a real file path via a
small helper, and Gary auto-receives the image pixels on the user's next chat
turn.

This builds on the attached-terminal feature
(`2026-06-16-attached-terminal-design.md`): the terminal is xterm.js over a raw
PTY WebSocket, one PTY per chat session, cwd = workspace root.

## Context & constraints

- **Raw PTY, no input buffer we own.** The terminal is a passthrough: whatever
  is displayed *is* what was sent to the shell (`send({type:'input', data})` in
  `frontend/js/workspace-terminal.js`). There is no separate composer we can
  render a placeholder in while sending something else (the Warp model is not
  available). Therefore the token typed into the PTY is literal text the shell
  receives — resolution to a real path happens out-of-band via a helper.
- **Existing upload pipeline.** `POST /api/upload` (`backend/uploads.py`) stores
  files at `~/.openclaw/workspace/.attachments/<id><ext>` — inside the agent
  vault, so Gary can already read the bytes — and returns `{id, name, url}`.
  Reuse it unchanged.
- **Existing chat→agent attachment path.** Chat sends `attachments` (JSON ids)
  on the turn; `bridge.py._open_turn` forwards them to the gateway as base64
  image blocks for vision-capable models. The terminal-dropped images merge into
  this same channel.
- **Existing per-turn context hook.** `terminals.py:gary_capability_note()`
  already injects a per-turn note + a minted terminal token into Gary's turn
  context, mirroring `mint_terminal_token` / `resolve_terminal_token`. The
  token→path map for terminal attachments rides along here.
- **PTY env is built before fork.** `terminals.py:PtySession.start()` builds
  `env` and already sets `OPENCLAW_ATTACHED_TERMINAL=1`; we add
  `OPENCLAW_SESSION_KEY` so the in-terminal helper knows which session to query.
- **Frontend pattern.** `workspace-terminal.js` is a self-contained IIFE (no
  module imports). New listeners and the upload/attach calls use bare `fetch`,
  not the `fileHandler.js` ES module.
- **Verification constraint:** no headless Chrome on this box
  (`feedback_no_headless_chrome`). Verify via `node --check`, pytest, curl
  handshakes, and user eyeballs on the 8443 origin.

## Goals

- Drop **or** paste an image onto the terminal panel → image saved + visible
  `[name.ext]` token typed at the cursor.
- The in-terminal CLI can turn `[name.ext]` into a real path on demand.
- Gary (web chat) auto-receives the image pixels on the user's next chat turn,
  and can resolve `[name.ext]` references in chat text or terminal output.
- Non-image drops/pastes pass through to the shell unchanged.

## Non-goals (out of scope)

- Auto-expanding a bare `[name.ext]` token for an arbitrary CLI (impossible in a
  raw PTY without a per-program integration). The helper is the documented path.
- Non-image files (PDFs, archives, etc.).
- Image editing, cropping, or previews inside the terminal.

## Data model — the per-session attachment registry

A per-session store, persisted to disk because the three readers/writers are
**separate processes**: the WebSocket pump, the chat-turn request handler, and
the `garyimg` helper subprocess.

- **Location:** `~/.openclaw/workspace/.data/terminal_attachments/<session_key>.json`
  (create dir on demand; `session_key` sanitized for filesystem safety —
  reuse/derive from the existing key-handling in `terminals.py`).
- **Shape:**
  ```json
  {
    "[gary.png]":  {"id": "ab12cd34.png", "name": "gary.png",
                     "path": "/Users/.../.attachments/ab12cd34.png",
                     "mime": "image/png", "ts": 1718560000, "pending": true},
    "[pasted-1.png]": { ... }
  }
  ```
- **Token rules:**
  - Token = `[<basename>]` from the uploaded filename.
  - Clipboard images have no filename → `pasted-1.png`, `pasted-2.png`, …
    (counter scoped to the session registry).
  - Collisions (same basename, different file) → suffix `-2`, `-3`:
    `[gary.png]`, `[gary-2.png]`.
- **`pending`:** `true` until consumed by a chat turn. The token→path mapping
  itself persists for the lifetime of the terminal session (so the CLI can
  resolve at any time); only `pending` is flipped to `false` on consumption.
- **Lifecycle:** the registry file is removed when the PTY session is closed
  (`terminals.py:close_session`).

## Components

### A. Backend endpoints (`backend/terminals.py`)

Mirror the existing `gary-mode` GET/POST routes (same loopback +
Serve-identity-header guard via `terminal_access_allowed`).

- `POST /api/terminal/{session_key}/attach`
  Body `{file_id, name, mime}`. Computes a unique token, writes the registry
  entry with `pending:true`, returns `{token}`.
- `GET /api/terminal/{session_key}/attachments?pending=1`
  Lists registry entries (optionally filtered to pending). Used by the chat-turn
  merge.
- `GET /api/terminal/{session_key}/resolve?token=[gary.png]`
  Returns `{path}` for the token, or 404 if unknown. Used by the helper.

A small module-level helper set in `terminals.py` owns the registry file I/O
(`_attachments_path(key)`, `_load(key)`, `_save(key, data)`,
`register_attachment(...)`, `list_attachments(key, pending_only)`,
`resolve_attachment(key, token)`, `mark_consumed(key, tokens)`).

### B. Frontend (`frontend/js/workspace-terminal.js`)

Add, on `#wt-screen`:

- `dragover` (preventDefault to allow drop) and `drop` handlers.
- `paste` handler.

Logic (shared `handleImageFiles(files)`):
1. Filter to images (reuse the chip test: `type startsWith 'image/'` or
   extension match). If none, do **not** preventDefault — let the event pass
   through to the shell normally.
2. For each image, in order:
   - `status('uploading image…')`.
   - `POST /api/upload` (multipart `files`) → `{id, name, url}`.
   - `POST /api/terminal/{sessionKey}/attach` `{file_id:id, name, mime}` →
     `{token}`.
   - Inject into the PTY: `send({type:'input', data: token + ' '})` (trailing
     space; multiple images → space-separated tokens at the cursor).
3. `status('')` on success; on any failure `status('image upload failed')` and
   inject nothing for that file.

Guards: only act when `ws.readyState === 1` (connected) and `sessionKey` is set.

### C. Resolver helper (`bin/garyimg`)

A tiny executable script placed on the PTY's PATH (cwd = workspace root, so
`bin/garyimg` is reachable as `./bin/garyimg`; document adding `bin` to PATH or
invoking by relative path). The PTY env carries `OPENCLAW_SESSION_KEY`.

- Usage: `garyimg gary.png` or `garyimg '[gary.png]'` (brackets optional).
- Reads `OPENCLAW_SESSION_KEY`, GETs `/api/terminal/{key}/resolve`, prints the
  absolute path to stdout, exit 0.
- Unknown token / missing env / backend down → message to **stderr**, exit
  nonzero (so `$(garyimg …)` fails loudly rather than producing a bad path).
- Idiomatic use: `claude "look at $(garyimg gary.png)"`,
  `cat "$(garyimg gary.png)"`.

(Language: a short Python or Node script consistent with the other `bin/`
helpers; it only needs an HTTP GET against `127.0.0.1:8800`.)

### D. Gary chat awareness (`backend/bridge.py`)

In `_open_turn`, before sending the turn for a given `session_key`:

1. `list_attachments(session_key, pending_only=True)`.
2. For each, build the same base64 image attachment block the chat-upload path
   produces (read bytes from `path`, base64, `{type, mimeType, fileName,
   content}`), and append to the turn's `attachments` list.
3. `mark_consumed(session_key, tokens)` (flip `pending:false`; keep the
   token→path mapping).

Additionally, extend the per-turn context emitted near
`gary_capability_note()` with the current session's full token→path map (every
token in the session registry, regardless of `pending`), so Gary can resolve
`[name.ext]` it sees in chat text or in terminal output via `read_output`.

## Data flow (end to end)

```
drop/paste image on #wt-screen
  → POST /api/upload                     → .attachments/<id><ext>  (vault, Gary-readable)
  → POST /api/terminal/{key}/attach      → registry["[gary.png]"] = {…, pending:true}
  → send({type:'input', data:'[gary.png] '})   → token echoes at cursor

in-terminal CLI:  garyimg gary.png       → GET /resolve            → prints /…/.attachments/<id>.png
next chat turn :  bridge._open_turn       → merge pending → turn attachments (base64)
                                          → mark_consumed; token→path map added to turn context
                  Gary sees pixels + can resolve [gary.png] in chat/terminal text
```

## Error handling

- Upload or attach failure → terminal status line, no token injected for that
  file; other files in the batch still attempt.
- Non-image drop/paste → event not prevented, passes through to the shell.
- Unknown/expired token at `/resolve` → 404; `garyimg` exits nonzero to stderr.
- Missing/unreadable file at chat-turn merge → skip that attachment, log, do not
  fail the turn.
- Registry file corrupt/missing → treated as empty; attach recreates it.

## Security

- New routes reuse `terminal_access_allowed` (loopback + Serve identity header),
  identical to the `gary-mode` routes.
- `/resolve` only returns paths that exist in the session's own registry, which
  only ever contains `.attachments/<id>` paths produced by `/api/upload`. No
  arbitrary-path resolution.
- `session_key` is sanitized before use as a filename for the registry file (no
  traversal).

## Testing

- **pytest** (`backend/tests/`):
  - attach → registry entry created with correct token + `pending:true`.
  - token collision suffixing (`-2`).
  - clipboard fallback naming (`pasted-N`).
  - `list_attachments(pending_only)` filtering.
  - `resolve` returns the path; unknown token → 404.
  - bridge merge: pending attachments become turn attachment blocks and are
    marked consumed; missing file is skipped without failing.
- **Static / handshake:**
  - `node --check frontend/js/workspace-terminal.js`.
  - curl the three new endpoints against `127.0.0.1:8800` with the Serve header.
  - `garyimg` resolves a registered token end to end.
- **Manual (user, on the 8443 origin):** drop an image → token appears; paste an
  image → token appears; `garyimg name` prints a real path; send a chat message
  after dropping → Gary describes the image.

## Open defaults (chosen, not blocking)

- Helper name: `garyimg`. Usage form: `$(garyimg name)`.
- Pending attachments consumed on the **next** chat turn (no explicit
  "send to Gary" button).
- Token format: `[basename]`; clipboard → `pasted-N`; collisions → `-N`.
