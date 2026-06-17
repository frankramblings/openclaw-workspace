# Terminal Scrollback Persistence (Tier A) — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorm) — pending spec review → implementation plan
**Related:** extends the per-chat attached terminal (`backend/terminals.py`, `frontend-overrides/js/workspace-terminal.js`); see also the terminal slickness batch (`docs/superpowers/plans/2026-06-16-terminal-slickness.md`) and the GEEKOM migration.

## Goal

A terminal's **contents** (scrollback/output) and **working directory** survive anything, including a full reboot. Reopening a chat's terminal replays yesterday's output and drops you into a **fresh** shell in the same directory, so you continue where you left off.

## Non-Goals (explicit)

- **Live-process survival is out of scope.** A running `vim`/`tail -f`/REPL is *not* resumed. A reboot ends processes; we restore context, not a frozen process. (Tier B = tmux for non-reboot restarts; Tier C = CRIU for reboot — both deferred. tmux remains a separate future option if live-process survival across non-reboot restarts is ever wanted.)
- No remote/cloud sync of scrollback. Local disk only.

## Why "contents", not tmux

tmux keeps sessions in an in-memory server process; a reboot kills it and every session. tmux solves Tier B (gateway/workspace restart), not the stated requirement (reboot). Tier A is achieved by persisting our own output stream to disk — which is just files, so it survives reboots — and is a small extension of what `terminals.py` already does (an always-on reader maintaining an in-RAM `self.buffer`, capped at `MAX_BUFFER = 120_000`).

## Architecture

Each `PtySession` gains a durable, on-disk mirror of its output plus a small metadata record. The in-RAM `self.buffer` becomes a *tail cache* of the on-disk log rather than the source of truth.

```
terminals/<sanitized_session_key>/
  scrollback.log   # rolling tail of PTY OUTPUT bytes (scrubbed), ~1 MB cap
  meta.json        # { last_cwd, last_active (epoch), cols, rows, persist (bool) }
```

Location: under the workspace data dir, mirroring the existing
`_attachments_dir()` / `_attachments_path()` / `_sanitize_key()` helpers in
`terminals.py`. Directory mode `700`, files mode `600`.

### Components

**1. Persistence store (new, in `terminals.py`)**
- `persist_dir(session_key) -> Path` — `<data>/terminals/<sanitized_key>/`, created `700`.
- `append_output(session_key, text)` — scrub, append to `scrollback.log`, enforce the rolling cap, mode `600`. Called from the output path on a **batched flush** (see below), never per byte.
- `load_tail(session_key) -> str` — read the log tail (up to `MAX_BUFFER`) to seed `self.buffer` on `get_or_create`.
- `write_meta(session_key, **fields)` / `read_meta(session_key)` — JSON `meta.json`.
- `clear(session_key)` — unlink the session dir (for kill / clear-history / chat-deletion).
- `prune(max_idle_days=30)` — remove session dirs whose `meta.last_active` is older than the threshold.

**2. Write path (modify the always-on reader)**
The reader already drains PTY output continuously into `self.buffer`. Add a
**batched flush**: accumulate drained output and flush to `scrollback.log` on a
short interval (e.g. ~1 s) or when the pending chunk exceeds a size threshold,
whichever first. Rationale: per-keystroke disk writes are unacceptable given the
host's I/O sensitivity and the prior EMFILE incident — open the log file handle
once per flush (or keep one handle with periodic flush), do not reopen per write.

**3. Secret scrubber (new, pure function)**
`scrub(text) -> text` masking well-known token shapes before they reach disk:
- GitHub tokens: `ghp_[A-Za-z0-9]{36}`, `gho_`, `ghs_`, `ghr_`, `github_pat_…`
- OpenAI-style: `sk-[A-Za-z0-9]{20,}`
- AWS access key ids: `AKIA[0-9A-Z]{16}`
- JWTs: `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
- PEM private-key blocks: `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----` … `-----END … PRIVATE KEY-----`

Replaced with `***REDACTED***`. **Defense-in-depth only — explicitly not a guarantee.** It will miss novel/format-unknown secrets and may occasionally mask token-shaped legit output. It is a backstop behind encryption + the incognito control, never the primary protection. Unit-tested against a fixture of each pattern (positive) and near-misses (no false-positive on ordinary output).

**4. cwd capture**
- **Linux (GEEKOM target):** on each flush, read `os.readlink('/proc/<shell_pid>/cwd')` and store as `meta.last_cwd`. No shell-rc injection required.
- **macOS (interim):** `/proc` absent → cwd is best-effort (left unset); restore falls back to the workspace root. Contents restore works regardless.

**5. Restore (modify `get_or_create` / panel attach)**
When a chat terminal attaches and there is **no live PTY** but a `scrollback.log` exists:
1. Seed `self.buffer` from `load_tail`.
2. Emit a dim separator line into the client stream: `──── restored <local time> · <last_cwd or ~> ────`.
3. Spawn the fresh shell with `cwd = meta.last_cwd` (if present & still exists) else workspace root.
When a live PTY already exists (ordinary non-reboot reconnect), behavior is
unchanged: replay the in-RAM buffer as today.

**6. User controls (frontend + backend)**
- **Incognito / don't-persist toggle** — per terminal. When off, `append_output` is a no-op and any existing log for that session is cleared. Persisted in `meta.persist`. New control in the panel header (alongside Gary/pin/restart/kill).
- **Clear saved history** — folded into the existing 🗑 kill button (or a dedicated action): calls `clear(session_key)` to wipe the on-disk log immediately. Confirm before wiping.

**7. Retention**
- `prune(30)` runs on backend startup and once daily.
- `close_session` and chat-deletion call `clear(session_key)` immediately.
- Rolling ~1 MB per-session cap bounds size; idle prune bounds lifetime.

## Data Flow

```
PTY output → reader drain → self.buffer (tail cache, RAM)
                          ↘ (batched flush, if persist) → scrub → scrollback.log (disk, 600)
                          ↘ (each flush, Linux) → /proc/<pid>/cwd → meta.json

Attach with no live PTY + log exists:
  load_tail → seed buffer → emit "restored …" separator → spawn shell in last_cwd
```

## Error Handling

- Disk write failure (full disk, perms): log a warning, **degrade gracefully** — the terminal keeps working in-memory; persistence is best-effort and never blocks the PTY.
- Corrupt/partial `meta.json`: treat as missing (fresh shell at workspace root); do not crash attach.
- `last_cwd` no longer exists on restore: fall back to workspace root.
- Scrubber must never throw on arbitrary bytes; operate on decoded text with errors-replaced.

## Security

- **Primary control = full-disk encryption.** **LUKS on the GEEKOM box is a hard migration-checklist item** (added to the migration plan). The mini (FileVault currently OFF, being retired) runs perms-only for the short interim — an accepted, time-boxed risk.
- **Minimal capture:** only terminal *output* is persisted; raw keystrokes are never logged. Interactive password prompts disable echo, so typed passwords never enter the output stream.
- Perms `700`/`600` under the already-access-gated workspace data dir.
- Scrubber (defense-in-depth) + incognito toggle (opt-out) + clear-history (immediate wipe) + bounded retention (size + idle prune) reduce exposure volume and window.

## Testing

Backend (pytest, real filesystem in a tmp dir — never the live store):
- `scrub()` masks each token pattern; leaves ordinary output (incl. near-miss strings) intact.
- `append_output` enforces the rolling cap (write > cap → file holds only the tail) and writes mode `600`, dir `700`.
- `load_tail` round-trips appended content; seeds buffer correctly.
- `prune` removes only dirs older than the threshold; keeps fresh ones; `clear` unlinks immediately.
- `persist=False` (incognito) makes `append_output` a no-op and clears any existing log.
- Restore path: given a log + meta, attach with no live PTY seeds buffer, emits the separator, and selects `last_cwd` (or falls back when it doesn't exist).
- cwd capture is abstracted behind a small `read_cwd(pid)` seam so it can be tested without a real `/proc` (Linux real-read covered by an integration check on the target).

Frontend: incognito toggle flips `meta.persist` via the backend; clear-history confirms then calls clear. (Rendering/visual bits are eyeball-verified per the no-headless-Chrome constraint.)

## Open dependencies / checklist

- [ ] Add **LUKS full-disk encryption** to the GEEKOM migration checklist (gates the at-rest security of this feature).
- [ ] Confirm the workspace data-dir root used for `terminals/` on the target matches the migrated path (`/Users/admin` → `/home/<user>` rewrite).
