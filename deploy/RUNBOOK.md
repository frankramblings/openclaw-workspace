# Runbook

Operational reference for the production deploy. Unit files live in
`deploy/systemd/` (see that directory's README for install instructions);
this doc is about running and recovering the already-installed system.

## Deploy

```bash
git pull && scripts/sync-frontend.sh && \
  systemctl --user restart openclaw-workspace.service && \
  scripts/smoke.sh http://127.0.0.1:8800
```

`sync-frontend.sh` rebuilds `frontend/` from `frontend-vendor/` +
`frontend-overrides/` — skipping it means the running app keeps serving the
old frontend even after a restart. The restart is the app-only unit; the
gateway (`openclaw-gateway.service`) doesn't need restarting for a workspace
code change.

## Service management

```bash
# status of both units
systemctl --user status openclaw-workspace.service openclaw-gateway.service

# tail logs live
journalctl --user -u openclaw-workspace.service -f
journalctl --user -u openclaw-gateway.service -f

# restart both (workspace depends on gateway being up, but doesn't need it
# restarted in lockstep — restart individually unless troubleshooting both)
systemctl --user restart openclaw-workspace.service openclaw-gateway.service

# timers (backup, tmp reaper, doctor alert)
systemctl --user list-timers 'openclaw-*'
```

## Recovery

### Gateway crash-loop

The gateway renders podcast-style jobs into `rf_*`/`ge_*` temp dirs
(hundreds of MB each) under `TMPDIR` (`~/.cache/openclaw-tmp`, redirected off
`/tmp` tmpfs by `openclaw-gateway.service.d/tmpdir.conf` — `/tmp` has a
per-user quota that these dirs can fill, which previously crash-looped the
gateway with `EDQUOT`). If the gateway is crash-looping:

```bash
df -h /tmp ~/.cache/openclaw-tmp          # check for a filled quota/disk
systemctl --user status openclaw-tmp-reaper.timer
systemctl --user start openclaw-tmp-reaper.service   # force an immediate reap
journalctl --user -u openclaw-gateway.service -n 100 --no-pager
```

If the reaper timer isn't enabled/active, that's the root cause — enable it
(`systemctl --user enable --now openclaw-tmp-reaper.timer`) and re-check disk
usage before assuming anything else is wrong.

### Workspace 502 (via Tailscale Serve)

`openclaw-workspace.service` is tuned to restart fast on purpose
(`TimeoutStopSec=5`, `KillMode=mixed`, `--timeout-graceful-shutdown 2`): the
app always holds long-lived SSE/WS streams that never drain gracefully, so a
normal restart force-closes them rather than waiting out uvicorn's full
graceful-shutdown window. A restart — even a clean one — costs **at most
~5 seconds** of 502s at the Tailscale Serve edge; clients reconnect and
resume by cursor. If a 502 persists longer than that, the restart itself is
failing — check `journalctl --user -u openclaw-workspace.service -n 100` for
a crash loop (bad venv, syntax error, port already bound) rather than
assuming it will self-heal.

A loopback caller with no `Tailscale-User-Login` header (e.g. local `curl` to `/api/terminal/...`, bypassing Serve) is denied terminal access by default since Task 14 — set `OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK=1` only if you've verified nothing but this host can reach uvicorn's loopback bind.

## Backup / restore

Nightly `openclaw-backup.service` (03:30 local, `openclaw-backup.timer`) runs
`restic backup` over workspace + agent state, then `restic forget --prune`.
Secrets (`RESTIC_PASSWORD`, `RESTIC_REPOSITORY`) live in
`~/.config/openclaw-secrets/restic.env` — not in this repo. The repository
lives on a separate, offsite restic host (not this machine), so a local disk
loss doesn't take the backups with it.

**A failed `openclaw-backup.service` run does not necessarily mean data
loss.** The service runs `backup` and then `forget --prune` back to back; if
`backup` succeeds but the later `forget --prune` step fails (e.g. a
transient network hiccup to the offsite host), systemd reports the whole
oneshot as failed even though the night's snapshot is already safely in the
repository. **Always check `restic snapshots` first** before assuming the
backup itself was lost — a failed unit with a snapshot from that night
present is a prune failure, not a backup failure.

```bash
source ~/.config/openclaw-secrets/restic.env
export RESTIC_PASSWORD RESTIC_REPOSITORY

restic snapshots                                    # confirm what actually landed
restic restore latest --target /tmp/restore-check    # restore-and-verify without touching live state
```

Restore into `/tmp/restore-check` (or any scratch path), diff/inspect, then
copy back only what you need — never restore directly over live state.

## Alerting

`openclaw-doctor-alert.timer` runs every 5 minutes, probing `/api/health` and
`/api/gateway/status` on the workspace app. State transitions (`ok → down`,
`down → ok`) post to the URL in `NTFY_URL`
(`~/.config/openclaw-secrets/alerts.env` — not in this repo), and re-remind
every 6 hours while still down. Dedup state lives in
`~/.cache/openclaw-doctor-alert.state` (`"<ok|down> <unix-ts>"`); delete it
to force the next run to treat the current state as fresh.

**To change the alert channel**, edit `NTFY_URL` in `alerts.env` to any
endpoint that accepts a POST body as a plain-text message (ntfy, a generic
webhook, etc.) — the script just does `curl -d "$body" "$NTFY_URL"`. A
structured target (e.g. a Slack incoming webhook expecting
`{"text": "..."}`) needs the script's `notify()` body reshaped, not just a
URL swap.

**Auto-restart escalation (workspace only, never the gateway).** A wedged-but-
listening workspace app can fail `/api/health` forever without recovering on
its own, so 3 CONSECUTIVE workspace-probe failures (≈10-15 min wedged)
trigger `systemctl --user restart openclaw-workspace` and an
`AUTO-RESTART: ...` notify, gated by a 1-hour cooldown so a crash-looping
service can't be restarted more than once/hour even across brief recoveries.
A gateway-only failure (workspace answers 200 while the gateway is
`down`/unreachable) never counts toward this — the gateway's own restart is
a normal 4-5 min cold boot and is exempt from auto-restart entirely. The
consecutive-fail count and last-restart timestamp live in
`~/.cache/openclaw-doctor-alert.fails` (`"<count> <last_restart_unix-ts>"`,
written atomically like the state file above); a workspace-ok probe resets
the count to 0 but preserves the cooldown timestamp. Delete the file to
clear both. `DOCTOR_DRYRUN=1` prints `would restart openclaw-workspace`
instead of restarting and skips the notify — useful for testing against an
overridden `HOME`/`HEALTH_URL`, never against the live install.
