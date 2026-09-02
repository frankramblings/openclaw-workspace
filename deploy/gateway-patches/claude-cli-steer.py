#!/usr/bin/env python3
"""Give the OpenClaw gateway's claude-cli reply handle a `queueMessage`, so the
gateway's existing steer queue can inject a mid-turn message into a running
Claude Code turn instead of waiting for it to end.

WHY: with messages.queue.mode = steer (the default), a chat.send that arrives
while a session's run is active goes runReplyAgent ->
queueEmbeddedAgentMessageWithOutcomeAsync -> queueReplyRunMessage ->
backend.queueMessage. The claude-cli handle built in runClaudeLiveSessionTurn
is {kind, cancel, isStreaming} with no queueMessage, so the outcome is
"no_active_run" and the message is queued as a follow-up. Claude Code itself
accepts a mid-turn stdin user message and delivers it after the running tool's
result (verified 2026-09-01), so the only missing piece is this method.

WHAT: writeTurnInput() wraps the text as a stream-json user line (the same call
the turn's own prompt uses). options.userTurnTranscriptRecorder.persistApproved()
records the user turn in the session transcript so chat.history shows it.
queueReplyRunMessage does not await queueMessage, so this never throws
synchronously and swallows its own async errors (logged).

REAPPLY-SAFE: `openclaw update` rewrites the bundle (and may rename it). This
script globs the dist dir for runClaudeLiveSessionTurn, requires EXACTLY ONE
unpatched anchor, is a no-op once patched, and never exits non-zero, so it can
run as a gateway ExecStartPre without ever blocking startup.

Run as root (the bundle is root-owned):
    sudo python3 claude-cli-steer.py
Env OPENCLAW_DIST_DIR overrides the dist directory (tests).
"""
import glob
import os
import sys

DEFAULT_DIST = "/usr/lib/node_modules/openclaw/dist"
MARKER = "/*CLI_STEER*/"
NEEDLE = "async function runClaudeLiveSessionTurn"
TARGET = "\t\tisStreaming: () => !replyBackendCompleted\n\t} : void 0;"
PATCHED = (
    "\t\tisStreaming: () => !replyBackendCompleted,\n"
    "\t\t" + MARKER + "queueMessage: (text, options) => {\n"
    "\t\t\tconst p = (replyBackendCompleted || liveSession.closing || !liveSession.currentTurn)\n"
    "\t\t\t\t? Promise.reject(new Error(\"Claude CLI live session has no active turn to steer\"))\n"
    "\t\t\t\t: writeTurnInput(liveSession, String(text)).then(async () => {\n"
    "\t\t\t\t\tconst rec = options && options.userTurnTranscriptRecorder;\n"
    "\t\t\t\t\tif (rec && typeof rec.persistApproved === \"function\") {\n"
    "\t\t\t\t\t\ttry { await rec.persistApproved(); } catch { /* transcript is best-effort */ }\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t});\n"
    "\t\t\tp.catch((err) => cliBackendLog.warn(`claude live steer failed: ${formatErrorMessage(err)}`));\n"
    "\t\t\treturn p;\n"
    "\t\t}\n"
    "\t} : void 0;"
)


def find_file(dist_dir):
    for path in sorted(glob.glob(os.path.join(dist_dir, "*.js"))):
        try:
            with open(path, encoding="utf-8") as f:
                s = f.read()
        except (OSError, UnicodeDecodeError):
            continue
        if NEEDLE in s:
            return path, s
    return None, None


def apply(dist_dir):
    path, s = find_file(dist_dir)
    if not path:
        print("[claude-cli-steer] WARN: %s not found in %s (gateway updated/renamed?) "
              "- skipping" % (NEEDLE, dist_dir), file=sys.stderr)
        return 0
    if MARKER in s:
        print("[claude-cli-steer] already patched: %s" % path)
        return 0
    n = s.count(TARGET)
    if n != 1:
        print("[claude-cli-steer] WARN: expected 1 patch target, found %d in %s "
              "- skipping (bundle shape changed?)" % (n, path), file=sys.stderr)
        return 0
    # The write is the one step that can still raise (not run as root, a
    # read-only mount, a full disk). Never let that exit non-zero: this runs as
    # an ExecStartPre and a failing pre-step would keep the gateway down over
    # an OPTIONAL patch.
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(s.replace(TARGET, PATCHED, 1))
    except OSError as e:
        print("[claude-cli-steer] WARN: could not write %s (%s) - skipping "
              "(run as root?)" % (path, e), file=sys.stderr)
        return 0
    print("[claude-cli-steer] patched %s" % path)
    return 0


def main():
    return apply(os.environ.get("OPENCLAW_DIST_DIR") or DEFAULT_DIST)


if __name__ == "__main__":
    sys.exit(main())
