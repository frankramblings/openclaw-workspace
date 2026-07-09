# systemd units

These are the canonical production units for the production host — a
byte-for-byte snapshot of what actually runs `~/.config/systemd/user/`, with two private
`Environment=` values in `openclaw-workspace.service` swapped for placeholders
(see the comment inline). Everything else here is verbatim.

## What's here

| File | Purpose |
|---|---|
| `openclaw-workspace.service` | The web app (`backend.app:app` via uvicorn), port 8800 loopback. |
| `openclaw-gateway.service` | The OpenClaw gateway (`openclaw gateway --port 18789`). |
| `openclaw-gateway.service.d/java-ipv4.conf` | Forces IPv4 for a JVM-based tool the gateway shells out to. |
| `openclaw-gateway.service.d/voyage.conf` | Points the gateway at its secrets `EnvironmentFile` (path only, no values). |
| `openclaw-gateway.service.d/tmpdir.conf` | Redirects gateway render temp off `/tmp` tmpfs onto real disk (see comment in the file — a filled tmpfs quota once crash-looped the gateway). |
| `openclaw-tmp-reaper.{service,timer}` | Hourly cleanup of orphaned gateway render temp dirs. |
| `openclaw-backup.{service,timer}` | Nightly restic backup of workspace + agent state. |
| `openclaw-doctor-alert.{service,timer}` | Every-5-minutes health probe of the app + gateway, alerts on state change via ntfy; auto-restarts the workspace app after 3 consecutive failures (see `deploy/RUNBOOK.md`). |
| `bin/openclaw-reap-tmp` | Script run by `openclaw-tmp-reaper.service`. |
| `bin/openclaw-backup` | Script run by `openclaw-backup.service`. Reads secrets from `~/.config/openclaw-secrets/restic.env` (not included here). |
| `bin/openclaw-doctor-alert` | Script run by `openclaw-doctor-alert.service`. Reads secrets from `~/.config/openclaw-secrets/alerts.env` (not included here). |

None of the two secrets env files (`restic.env`, `alerts.env`) are in this
repo — they hold a restic repository password and an ntfy topic URL
respectively. Create them yourself (see `deploy/RUNBOOK.md`) before enabling
the backup/alert timers.

## Install

```bash
# unit files
cp deploy/systemd/openclaw-workspace.service \
   deploy/systemd/openclaw-gateway.service \
   deploy/systemd/openclaw-tmp-reaper.service deploy/systemd/openclaw-tmp-reaper.timer \
   deploy/systemd/openclaw-backup.service deploy/systemd/openclaw-backup.timer \
   deploy/systemd/openclaw-doctor-alert.service deploy/systemd/openclaw-doctor-alert.timer \
   ~/.config/systemd/user/
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d
cp deploy/systemd/openclaw-gateway.service.d/*.conf \
   ~/.config/systemd/user/openclaw-gateway.service.d/

# edit the two placeholder Environment= lines in the copied
# openclaw-workspace.service to your own values before starting it

# scripts
cp deploy/systemd/bin/* ~/.local/bin/
chmod +x ~/.local/bin/openclaw-reap-tmp ~/.local/bin/openclaw-backup ~/.local/bin/openclaw-doctor-alert

systemctl --user daemon-reload
systemctl --user enable --now openclaw-workspace.service openclaw-gateway.service \
  openclaw-tmp-reaper.timer openclaw-backup.timer openclaw-doctor-alert.timer
```

See `deploy/RUNBOOK.md` for day-to-day operation, recovery, and the secrets
files each script expects.
