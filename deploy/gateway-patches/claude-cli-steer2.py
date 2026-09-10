#!/usr/bin/env python3
"""Real mid-turn steering for claude-cli sessions on gateway 2026.9.3+.

WHY A SECOND SCRIPT: the original `claude-cli-steer.py` patched
`runClaudeLiveSessionTurn`, the claude-cli REPLY BACKEND's turn function. The
2026.9.3 update deleted that seam - claude-cli is no longer a reply backend at
all, it is an agent RUNTIME executed from inside the embedded agent run
(`extensions/anthropic/cli.runtime.js`, `executeClaudeCli`). The embedded run
handle it now hangs off already exposes `queueMessage`, so a chat.send during
an active turn is ACCEPTED (ack ok + runId) - but it lands in the agent's own
steering queue, which the CLI turn never drains, so the running Claude Code
process never sees it. Measured 2026-09-09: the live-fire turn replied
NUMBER=NONE while the steer sat queued. The old script is a no-op on this
bundle (its needle is gone) and stays only for older installs.

WHAT THIS DOES - three anchored, additive edits:

  A) execute.runtime-*.mjs: pass the OpenClaw session key down into the CLI
     plugin execution context (`openclawSessionKey`). The context the runtime
     receives carries the CLAUDE session id, not OpenClaw's, so without this
     there is no shared key between the two sides.

  B) extensions/anthropic/cli.runtime.js: while a CLI turn is running,
     register a `send(text)` for that session key on a process-global map, and
     drop it in the turn's `finally`. `send` writes one stream-json user line
     on the SAME transport the turn's own prompt uses - the exact mechanism
     Claude Code accepts mid-turn and delivers at the next tool boundary.

  C) builtin-openclaw-*.mjs: in the embedded run's `queueMessage`, try that
     map FIRST. A hit writes to the live CLI stdin and records the user turn in
     the transcript; anything else (no CLI turn, a non-CLI model, a failed
     write) falls through to the stock queue path untouched.

REAPPLY-SAFE: `openclaw update` rewrites and renames the bundle. Each edit
globs for its own anchor, requires EXACTLY ONE unpatched match in EXACTLY ONE
file, is a no-op once the marker is present, and never exits non-zero, so this
can run as a gateway ExecStartPre without ever blocking startup. A partial
apply is safe by construction: C alone falls through to stock behaviour, B
alone registers a map nobody reads, A alone adds an unread property.

NOTE: the dist is SHARED with the second tenant. Every inserted statement is
inside a try/catch or guarded by an optional chain, so a shape change degrades
to the stock queue rather than throwing into someone else's turn.

Run as root (the bundle is root-owned):
    sudo python3 claude-cli-steer2.py
Env OPENCLAW_DIST_DIR overrides the dist directory (tests).
"""
import glob
import os
import sys

DEFAULT_DIST = "/usr/lib/node_modules/openclaw/dist"
MARKER = "/*CLI_STEER2*/"

# --- A: hand the OpenClaw session key to the CLI plugin runtime --------------
A_TARGET = "\t\t\tmodelId: params.context.normalizedModel,\n"
A_PATCHED = (
    "\t\t\tmodelId: params.context.normalizedModel,\n"
    "\t\t\t" + MARKER + "openclawSessionKey: params.context.params.sessionKey,\n"
)

# --- B: publish a stdin writer for the duration of a CLI turn ---------------
B_TARGET = "\tsession.currentTurn = turn;\n"
B_PATCHED = (
    "\tsession.currentTurn = turn;\n"
    "\t" + MARKER + "const steerKey = context.openclawSessionKey;\n"
    "\tif (steerKey) {\n"
    "\t\tconst map = globalThis.__OPENCLAW_CLI_STEER ??= new Map();\n"
    "\t\tmap.set(steerKey, { turn, send: async (text) => {\n"
    "\t\t\tif (session.closed || session.currentTurn !== turn || !session.transport) {\n"
    "\t\t\t\tthrow new Error(\"Claude CLI live session has no active turn to steer\");\n"
    "\t\t\t}\n"
    "\t\t\tawait session.transport.send({\n"
    "\t\t\t\ttype: \"user\",\n"
    "\t\t\t\tmessage: { role: \"user\", content: String(text) },\n"
    "\t\t\t\tparent_tool_use_id: null,\n"
    "\t\t\t\tuuid: randomUUID(),\n"
    "\t\t\t\t...context.sessionId ? { session_id: context.sessionId } : {}\n"
    "\t\t\t});\n"
    "\t\t} });\n"
    "\t}\n"
)
# The turn's own finally already runs on every exit path (return, throw,
# abort); unregister there so a dead key can never take a later steer. It
# re-reads the key off `context` rather than closing over B's `const steerKey`,
# so this edit stays correct even if B was skipped (see the partial-apply note).
# `turn.controller.abort()` alone appears twice in the file; the removeEventListener
# line that follows it pins this to executeClaudeCli's own finally.
B_FIN_TARGET = ("\t\tturn.controller.abort();\n"
                "\t\tcontext.abortSignal?.removeEventListener(\"abort\", abort);\n")
B_FIN_PATCHED = (
    "\t\t" + MARKER + "const doneKey = context.openclawSessionKey;\n"
    "\t\tif (doneKey && globalThis.__OPENCLAW_CLI_STEER?.get(doneKey)?.turn === turn) {\n"
    "\t\t\tglobalThis.__OPENCLAW_CLI_STEER.delete(doneKey);\n"
    "\t\t}\n"
) + B_FIN_TARGET

# --- C: prefer the live CLI stdin over the agent steering queue --------------
C_TARGET = ("\t\t\treturn await steerActiveSessionWithOptionalDeliveryWait("
            "input.activeSession, text, options, attempt.sessionKey, "
            "canInjectMessage, questionAuthority(assertCurrent, authorityKind));\n")
C_PATCHED = (
    "\t\t\t" + MARKER + "const cliSteer = globalThis.__OPENCLAW_CLI_STEER?.get(attempt.sessionKey);\n"
    "\t\t\tif (cliSteer) {\n"
    "\t\t\t\tawait cliSteer.send(text);\n"
    "\t\t\t\tconst rec = options?.userTurnTranscriptRecorder;\n"
    "\t\t\t\tif (typeof rec?.persistApproved === \"function\") {\n"
    "\t\t\t\t\ttry { await rec.persistApproved(); } catch { /* transcript is best-effort */ }\n"
    "\t\t\t\t}\n"
    "\t\t\t\toptions?.onQueueAccepted?.(true);\n"
    "\t\t\t\treturn;\n"
    "\t\t\t}\n"
) + C_TARGET

# (description, glob, target, replacement) - order matters only for the log.
EDITS = (
    ("session key -> cli runtime", "execute.runtime-*.mjs", A_TARGET, A_PATCHED),
    ("cli turn stdin writer", "extensions/anthropic/cli.runtime.js", B_TARGET, B_PATCHED),
    ("cli turn unregister", "extensions/anthropic/cli.runtime.js", B_FIN_TARGET, B_FIN_PATCHED),
    ("embedded queueMessage hook", "builtin-openclaw-*.mjs", C_TARGET, C_PATCHED),
)


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def apply_edit(dist_dir, name, pattern, target, patched):
    """Apply ONE edit. Returns True when the file ends up patched, False when
    the edit was skipped. Never raises."""
    hits = []
    for path in sorted(glob.glob(os.path.join(dist_dir, pattern))):
        s = _read(path)
        if s is None:
            continue
        if MARKER in s and patched.split(MARKER, 1)[1][:40] in s:
            print("[claude-cli-steer2] already patched (%s): %s" % (name, path))
            return True
        if s.count(target) == 1:
            hits.append((path, s))
    if len(hits) != 1:
        print("[claude-cli-steer2] WARN: %s - expected exactly 1 file with 1 anchor, "
              "found %d in %s/%s - skipping (bundle shape changed?)"
              % (name, len(hits), dist_dir, pattern), file=sys.stderr)
        return False
    path, s = hits[0]
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(s.replace(target, patched, 1))
    except OSError as e:
        print("[claude-cli-steer2] WARN: could not write %s (%s) - skipping "
              "(run as root?)" % (path, e), file=sys.stderr)
        return False
    print("[claude-cli-steer2] patched %s: %s" % (name, path))
    return True


def apply(dist_dir):
    done = sum(apply_edit(dist_dir, *edit) for edit in EDITS)
    print("[claude-cli-steer2] %d/%d edits in place" % (done, len(EDITS)))
    # Always 0: this runs as an ExecStartPre and steering is optional.
    return 0


def main():
    return apply(os.environ.get("OPENCLAW_DIST_DIR") or DEFAULT_DIST)


if __name__ == "__main__":
    sys.exit(main())
