# Gateway patches

Reapply-safe edits to the root-owned OpenClaw dist bundle. Each script globs
the dist dir, requires exactly one unpatched anchor, is idempotent, and never
exits non-zero so it can run as a gateway `ExecStartPre`.

| Script | What it does | Since | Bundle |
|---|---|---|---|
| `claude-cli-steer2.py` | Injects a mid-turn message into the RUNNING Claude Code process: passes the OpenClaw session key into the CLI runtime, publishes a stdin writer for the live turn, and makes the embedded run's `queueMessage` reach for it first. | 2026-09-09 | gateway 2026.9.3+ |
| `claude-cli-steer.py` | Same goal on the OLD bundle: adds `queueMessage` to the claude-cli reply handle. **No-op on 2026.9.3+** (its anchor, `runClaudeLiveSessionTurn`, no longer exists). Kept for older installs. | 2026-09-01 | pre-2026.9.3 |

## Which one do I need?

    grep -rl 'runClaudeLiveSessionTurn' /usr/lib/node_modules/openclaw/dist

Prints a file → v1. Prints nothing → v2. `GET /api/capabilities` accepts
either shape and reports `"steer": {"available": true}` once one is complete.

## Install v2 (Frank, once)

    sudo install -m 0755 deploy/gateway-patches/claude-cli-steer2.py ~/.openclaw/patches/claude-cli-steer2.py
    sudo python3 ~/.openclaw/patches/claude-cli-steer2.py     # expect "4/4 edits in place"
    systemctl --user restart openclaw-gateway.service

Then add to `~/.config/systemd/user/openclaw-gateway.service.d/claude-cli-steer2.conf`:

    [Service]
    ExecStartPre=-/usr/bin/sudo -n /usr/bin/python3 %h/.openclaw/patches/claude-cli-steer2.py

and `systemctl --user daemon-reload`. `%h` is systemd's home specifier, so this
works unchanged per user. The leading `-` is deliberate: steering is optional,
and a failing pre-step must never keep the gateway down.

The dist is SHARED with the second tenant, so her gateway picks the patch up on
her next restart. Do not restart her unit.

## Verify

    grep -c 'CLI_STEER2' /usr/lib/node_modules/openclaw/dist/extensions/anthropic/cli.runtime.js   # 2
    grep -c 'CLI_STEER2' /usr/lib/node_modules/openclaw/dist/builtin-openclaw-*.mjs                # 1
    grep -c 'CLI_STEER2' /usr/lib/node_modules/openclaw/dist/execute.runtime-*.mjs                 # 1
    curl -s localhost:8800/api/capabilities | grep -o '"steer":[^}]*}'                             # available: true

Then the real thing, against a claude-cli chat (id from the sidebar URL):

    scripts/livefire-steer.sh <session_id>                 # steer lands at a tool boundary
    SCENARIO=prose scripts/livefire-steer.sh <session_id>  # steer lands mid-prose

## Rollback

A pre-patch copy of all three v2 files is at
`~/.openclaw/patches/backup-2026-09-09/` (same relative layout as `dist/`):

    sudo cp -r ~/.openclaw/patches/backup-2026-09-09/. /usr/lib/node_modules/openclaw/dist/
    systemctl --user restart openclaw-gateway.service

Removing the drop-in first keeps the next start from re-applying it. Nothing
else in the workspace depends on the patch: with it gone `/api/capabilities`
reports steer unavailable and the client falls back to its own send queue.
