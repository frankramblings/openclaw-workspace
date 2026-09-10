"""The v2 (gateway 2026.9.3+) claude-cli steer patch: each of its four edits
applies exactly once, the set is idempotent, and a changed bundle shape is a
loud no-op rather than a corrupt file or a non-zero exit (it runs as the
gateway's ExecStartPre, so it must never keep the gateway down)."""
import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "gateway-patches" / "claude-cli-steer2.py"

# Minimal stand-ins for the three real bundle files, carrying only the anchors.
EXECUTE_RUNTIME = (
    "iterator = params.execute({\n"
    "\t\t\tcwd,\n"
    "\t\t\tmodelId: params.context.normalizedModel,\n"
    "\t\t\tuseResume: params.useResume\n"
    "\t\t});\n"
)
CLI_RUNTIME = (
    "async function* executeClaudeCli(context, secretInput) {\n"
    "\tconst turn = { context };\n"
    "\tsession.currentTurn = turn;\n"
    "\ttry {\n"
    "\t\tawait session.transport.send({ type: \"user\" });\n"
    "\t} finally {\n"
    "\t\tturn.controller.abort();\n"
    "\t\tcontext.abortSignal?.removeEventListener(\"abort\", abort);\n"
    "\t}\n"
    "}\n"
    # A second, unrelated `turn.controller.abort();` — the real file has one,
    # and the finally anchor must not be ambiguous because of it.
    "function elsewhere() {\n\t\tturn.controller.abort();\n}\n"
)
REGISTRY = (
    "function resolveReplyMessageInjectionRejection(params) {\n"
    "\tconst { operation } = params;\n"
    "\tif (!operation) return { reason: \"no_active_run\" };\n"
    "}\n"
)


def _load():
    spec = importlib.util.spec_from_file_location("claude_cli_steer2", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _dist(tmp_path, execute=EXECUTE_RUNTIME, cli=CLI_RUNTIME, registry=REGISTRY):
    d = tmp_path / "dist"
    (d / "extensions" / "anthropic").mkdir(parents=True)
    (d / "execute.runtime-AbC123.mjs").write_text(execute, encoding="utf-8")
    (d / "extensions" / "anthropic" / "cli.runtime.js").write_text(cli, encoding="utf-8")
    (d / "reply-run-registry.registry-Def456.mjs").write_text(registry, encoding="utf-8")
    (d / "unrelated-Q1.mjs").write_text("function nope() {}\n", encoding="utf-8")
    return d


def _texts(d):
    return (
        (d / "execute.runtime-AbC123.mjs").read_text(encoding="utf-8"),
        (d / "extensions" / "anthropic" / "cli.runtime.js").read_text(encoding="utf-8"),
        (d / "reply-run-registry.registry-Def456.mjs").read_text(encoding="utf-8"),
    )


def test_all_four_edits_apply_once(tmp_path):
    mod = _load()
    d = _dist(tmp_path)
    assert mod.apply(str(d)) == 0
    execute, cli, registry = _texts(d)
    # A: the session key is handed to the runtime, original field kept.
    assert "openclawSessionKey: params.context.params.sessionKey" in execute
    assert "modelId: params.context.normalizedModel," in execute
    # B: register + unregister, one marker each.
    assert cli.count(mod.MARKER) == 2
    assert "globalThis.__OPENCLAW_CLI_STEER ??= new Map()" in cli
    # registered under BOTH the session key and the session id: the embedded
    # queue is keyed by id, the CLI runtime only knew the key.
    assert "openclawSessionId" in execute and "openclawSessionId" in cli
    assert "session.transport.send({" in cli
    # Every identifier the injected `send` body reads must exist in its own
    # scope: a stale one (steerKey after the rename to steerKeys) parses fine
    # and then throws ReferenceError on the first real steer (2026-09-10).
    send_body = cli.split("send: async (text) => {", 1)[1].split("} };", 1)[0]
    assert "${steerKey}" not in send_body
    assert "steerKeys" in send_body
    assert "globalThis.__OPENCLAW_CLI_STEER.delete(k)" in cli
    # E: the reply-run gate answers "yes, injectable" for a live CLI turn before
    # the stock checks (which describe the embedded agent loop, not the CLI
    # process actually holding the turn open). The stock body survives after it.
    assert registry.count(mod.MARKER) == 1
    assert registry.index("__OPENCLAW_CLI_STEER") < registry.index('reason: "no_active_run"')
    assert "isAvailable: () => true" in registry


def test_idempotent(tmp_path):
    mod = _load()
    d = _dist(tmp_path)
    mod.apply(str(d))
    first = _texts(d)
    assert mod.apply(str(d)) == 0
    assert _texts(d) == first


def test_unregister_anchor_is_not_confused_by_the_second_abort_call(tmp_path):
    """`turn.controller.abort();` appears twice in the real cli.runtime.js; only
    the one inside executeClaudeCli's finally may be patched."""
    mod = _load()
    d = _dist(tmp_path)
    mod.apply(str(d))
    cli = _texts(d)[1]
    assert cli.count("for (const k of [context.openclawSessionKey") == 1
    assert cli.split("function elsewhere()")[1].count(mod.MARKER) == 0


def test_changed_shape_is_a_no_op_not_a_failure(tmp_path):
    mod = _load()
    d = _dist(tmp_path, cli="function executeClaudeCli() { /* rewritten */ }\n")
    assert mod.apply(str(d)) == 0
    cli = _texts(d)[1]
    assert mod.MARKER not in cli
    # the edits that DID match still applied; a partial apply is safe
    assert "openclawSessionKey" in _texts(d)[0]


def test_missing_dist_is_a_no_op(tmp_path):
    mod = _load()
    assert mod.apply(str(tmp_path / "nope")) == 0


def test_ambiguous_anchor_is_skipped(tmp_path):
    """Two files matching one glob+anchor means the bundle was reshaped; refuse
    rather than guess which is the live one."""
    mod = _load()
    d = _dist(tmp_path)
    (d / "execute.runtime-Dup999.mjs").write_text(EXECUTE_RUNTIME, encoding="utf-8")
    assert mod.apply(str(d)) == 0
    assert "openclawSessionKey" not in _texts(d)[0]
