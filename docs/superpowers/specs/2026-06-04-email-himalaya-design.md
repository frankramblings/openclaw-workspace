# Email tab → real himalaya Gmail mailbox — design

**Date:** 2026-06-04
**Status:** approved (shape), pending spec review
**Scope:** Make the Odysseus Email tab (`rail-email`) a genuine IMAP/SMTP mail
client backed by `himalaya`, connected to the user's Gmail. This replaces the
current triage-feed adapter on `/api/email/*`. One of two independent
subsystems in this round; **Calendar is a separate spec.**

## Goal

"Fool someone into thinking it's really Odysseus, fully functional." Odysseus's
Email tab is a real mailbox; today the workspace fakes it with the triage feed.
After this, the tab lists real Gmail folders/messages, opens full bodies, and
can **reply / forward / compose and actually send** — on the user's account, no
API billing (himalaya talks IMAP/SMTP directly).

## Decisions (settled in brainstorming)

1. **himalaya**, not the Gmail API. It's a real IMAP/SMTP client, provider-
   agnostic, and a first-class OpenClaw skill (`skills/himalaya`, 📧). Gmail-API
   reuse of the triage OAuth was the alternative; rejected (Gmail-locked, not
   himalaya, would still need a scope re-consent).
2. **Account: Gmail**, via a **Google App Password** (user generates it; needs
   2FA on). `imap.gmail.com:993` (TLS) / `smtp.gmail.com:465` (TLS).
3. **Credential in the macOS keychain**, never in a file. himalaya reads it via
   a `cmd` password source (`security find-generic-password …`). Nothing secret
   lands in the repo or `config.toml`.
4. **Replace** the triage adapter on `/api/email/*` with a himalaya-backed
   module. The unified triage feed **keeps its existing home**, the
   triage-dashboard app at `:3456` — no relocation work.
5. **AI-reply wired to the OpenClaw brain** in v1 (same bridge as chat → drafts
   a reply from the thread, on subscription pricing).

## Architecture

### Components

- **himalaya CLI** (`brew install himalaya`) + `~/.config/himalaya/config.toml`
  (Gmail account, keychain-backed password). The OpenClaw `himalaya` skill is
  enabled so the agent can use it too.
- **`backend/email_himalaya.py`** — new FastAPI router. Shells out to
  `himalaya -o json …` per request (stateless; same pattern as the inbox/skills
  adapters — no daemon). Maps himalaya JSON ⇄ the exact shapes the Odysseus
  email frontend (`emailInbox.js`, `emailLibrary.js`, `document.js`) expects.
- **`backend/inbox.py`** — keeps only the `/api/items` triage proxy; its
  `/api/email/*` adapter is removed (superseded).
- **Brain bridge** — `email_himalaya.py` calls the existing `bridge` to fetch a
  one-shot completion for AI-reply and summarize.

### Data flow (read)

`emailInbox.js` → `GET /api/email/list?folder&limit&offset&filter` →
`himalaya envelope list -f <folder> -o json` → map envelopes → `{emails,total}`.
`read/{uid}` → `himalaya message read <uid> -f <folder> -o json` (+ headers) →
`{subject, from_address, from_name, to, cc, date, body, body_html, attachments,
message_id, references}`.

### Data flow (send)

`document.js _sendEmail()` → `POST /api/email/send {to,cc,bcc,subject,body,
body_html,in_reply_to,references,attachments,account_id,wait_for_delivery}` →
backend builds an RFC-822/MIME message (text + optional HTML alternative +
attachments; `In-Reply-To`/`References` headers when replying) → pipe to
`himalaya message send` (stdin) → SMTP. Reply also marks the source
`\Answered`.

### uid & folder model

himalaya addresses messages by IMAP UID within a folder. Frontend already passes
`?folder=` on every per-message call, so `uid` = the himalaya/IMAP id verbatim
(no base64 needed — unlike the triage adapter). Gmail's IMAP folders are its
labels (`INBOX`, `[Gmail]/Sent Mail`, `[Gmail]/All Mail`, `[Gmail]/Trash`,
`[Gmail]/Spam`, `[Gmail]/Drafts`); `folders` maps these to the role names the
UI's `sortedFolders()` already understands.

## Endpoint contract (tiered)

**Tier 1 — the real mailbox (v1, must-have):**

| Endpoint | himalaya |
|---|---|
| `GET /api/email/accounts` | from config (one: Gmail) |
| `GET /api/email/list?folder&limit&offset&filter` | `envelope list` |
| `GET /api/email/folders` | `folder list` → role-mapped |
| `GET /api/email/read/{uid}?folder&mark_seen` | `message read` |
| `GET /api/email/search?folder&q&limit` | `envelope list` w/ IMAP search query |
| `POST /api/email/send` | build MIME → `message send` |
| `POST /api/email/ai-reply` | brain bridge (draft reply) |
| `POST /api/email/mark-read/{uid}` · `mark-unread` | `flag add/remove Seen` |
| `POST /api/email/mark-answered/{uid}` · `clear-answered` | `flag add/remove Answered` |
| `POST /api/email/archive/{uid}` | `message move` → All Mail (Gmail archive) |
| `DELETE /api/email/delete/{uid}` | `message move` → Trash |
| `POST /api/email/move/{uid}?dest` | `message move` |
| `GET /api/email/urgency-state` | stub `{per_uid:{}}` (no scanner) |

**Tier 2 — include if cheap:**
`POST /api/email/draft` (save to Drafts via `message save`/`template`),
`POST /api/email/summarize` (brain), `GET /api/email/attachment/{uid}/{idx}`
(`attachment download`), `POST /api/email/compose-upload` (+DELETE) (stage
attachment files in a temp dir, attach on send), `GET /api/email/contacts`
(derive from recent envelope senders), `POST /api/email/{uid}/unflag-spam`
(move out of Spam / no-op), `DELETE /api/email/delete-permanent/{uid}`
(`message delete` in Trash).

**Tier 3 — stub (himalaya/Odysseus-specific, not core):**
`GET /api/email/scheduled` → `[]` and `DELETE /api/email/scheduled/{id}` → ok
(himalaya has no scheduler; real scheduled-send is a later queue feature),
`GET /api/email/odysseus/reminders` → `[]`, `POST /api/email/attachment-as-doc`
→ 501. `send` ignores `wait_for_delivery` nuance beyond returning after the
send call completes.

Anything not listed is already covered by the app's catch-all `GET` (returns
`[]`); non-GET unknowns are not expected from these frontend modules.

## Credential & install steps (the human-in-the-loop part)

1. User: enable 2FA on the Google account (if not already), generate an **App
   Password** (Google Account → Security → App passwords).
2. Implementer: `brew install himalaya`; store the app password in keychain:
   `security add-generic-password -a <gmail-addr> -s himalaya-gmail -w <app-pw>`;
   write `config.toml` with `password.cmd = "security find-generic-password -a <gmail-addr> -s himalaya-gmail -w"`.
3. Implementer: set `skills.entries.himalaya.enabled = true` in `openclaw.json`.

## Error handling

- himalaya non-zero exit → 502 with the stderr tail surfaced into the UI's
  existing "Failed to load/send" affordances (frontend already renders
  `data.error`).
- Missing binary / unconfigured account → a clear setup hint (the UI shows
  `_emailSetupHint()` pointing at Settings → Integrations).
- Send failures return `{error}` so the composer keeps the draft (no data loss).

## Testing

- **Read** paths verified against the live mailbox (list/folders/read/search).
- **Send** tested by emailing **yourself** (`to` = own address) — no third-party
  spam; verify the message arrives + threads (`In-Reply-To`).
- **Destructive** (archive/delete/move) tested only on a **throwaway self-sent**
  message; verify the move/trash and restore where possible.
- **AI-reply** verified end-to-end through the brain bridge on a self-thread.
- Each endpoint's JSON shape diffed against what the frontend reads (the field
  lists captured in this spec).

## Out of scope (this spec)

- Calendar (separate spec).
- Multiple mail accounts (himalaya supports it; config-only to add later).
- Real scheduled send, server-side reminders, attachment-as-doc round-trip.
- Push/IDLE live updates (frontend polls; fine for v1).

## Frontend contract reference (must satisfy, do not edit frontend)

- List item fields read: `uid, subject, from_name, from_address, sender, date,
  snippet, is_read, is_answered, is_spam_verdict, has_attachments, tags`;
  list response `{emails, total}`. Folders `{folders:[...]}`.
- Read response: `subject, from_address, from_name, to, cc, date, body,
  body_html, snippet, message_id, references, attachments:[{index,filename,size}]`.
- Send payload: `{to, cc, bcc, subject, body, body_html, in_reply_to,
  references, attachments, account_id, wait_for_delivery}`.
- Accounts: `[{account_id, address, ...}]` (UI shows a picker only if >1).
