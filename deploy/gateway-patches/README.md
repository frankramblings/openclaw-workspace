# Gateway patches

Reapply-safe edits to the root-owned OpenClaw dist bundle. Each script globs
the dist dir, requires exactly one unpatched anchor, is idempotent, and never
exits non-zero so it can run as a gateway `ExecStartPre`.

| Script | What it does | Since |
|---|---|---|
| `claude-cli-steer.py` | Adds `queueMessage` to the claude-cli reply handle so the gateway's steer queue can inject a message into a running Claude Code turn. | 2026-09-01 |

Install (Frank, once):

    sudo install -m 0755 deploy/gateway-patches/claude-cli-steer.py ~/.openclaw/patches/claude-cli-steer.py
    sudo python3 ~/.openclaw/patches/claude-cli-steer.py
    systemctl --user restart openclaw-gateway.service

Then add to `~/.config/systemd/user/openclaw-gateway.service.d/claude-cli-steer.conf`:

    [Service]
    ExecStartPre=/usr/bin/sudo -n /usr/bin/python3 /home/frank/.openclaw/patches/claude-cli-steer.py

and `systemctl --user daemon-reload`. The shared dist means Marissa's gateway
picks the patch up on her next restart; do not restart her unit.

Verify: `grep -c 'CLI_STEER' /usr/lib/node_modules/openclaw/dist/claude-live-session-*.js` prints 1,
and `GET /api/capabilities` reports `"steer": {"available": true}`.
