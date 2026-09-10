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
BUILTIN = (
    "\tconst queueMessage = async (text, options, assertCurrent, authorityKind) => {\n"
    "\t\ttry {\n"
    "\t\t\treturn await steerActiveSessionWithOptionalDeliveryWait("
    "input.activeSession, text, options, attempt.sessionKey, "
    "canInjectMessage, questionAuthority(assertCurrent, authorityKind));\n"
    "\t\t} finally {}\n"
    "\t};\n"
)


def _load():
    spec = importlib.util.spec_from_file_location("claude_cli_steer2", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _dist(tmp_path, execute=EXECUTE_RUNTIME, cli=CLI_RUNTIME, builtin=BUILTIN):
    d = tmp_path / "dist"
    (d / "extensions" / "anthropic").mkdir(parents=True)
    (d / "execute.runtime-AbC123.mjs").write_text(execute, encoding="utf-8")
    (d / "builtin-openclaw-XyZ789.mjs").write_text(builtin, encoding="utf-8")
    (d / "extensions" / "anthropic" / "cli.runtime.js").write_text(cli, encoding="utf-8")
    (d / "unrelated-Q1.mjs").write_text("function nope() {}\n", encoding="utf-8")
    return d


def _texts(d):
    return (
        (d / "execute.runtime-AbC123.mjs").read_text(encoding="utf-8"),
        (d / "extensions" / "anthropic" / "cli.runtime.js").read_text(encoding="utf-8"),
        (d / "builtin-openclaw-XyZ789.mjs").read_text(encoding="utf-8"),
    )


def test_all_four_edits_apply_once(tmp_path):
    mod = _load()
    d = _dist(tmp_path)
    assert mod.apply(str(d)) == 0
    execute, cli, builtin = _texts(d)
    # A: the session key is handed to the runtime, original field kept.
    assert "openclawSessionKey: params.context.params.sessionKey" in execute
    assert "modelId: params.context.normalizedModel," in execute
    # B: register + unregister, one marker each.
    assert cli.count(mod.MARKER) == 2
    assert "globalThis.__OPENCLAW_CLI_STEER ??= new Map()" in cli
    assert "session.transport.send({" in cli
    assert "globalThis.__OPENCLAW_CLI_STEER.delete(doneKey)" in cli
    # C: the hook runs BEFORE the stock call, which survives untouched.
    assert builtin.count(mod.MARKER) == 1
    assert builtin.index("__OPENCLAW_CLI_STEER") < builtin.index(
        "steerActiveSessionWithOptionalDeliveryWait")
    assert "steerActiveSessionWithOptionalDeliveryWait(input.activeSession" in builtin


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
    assert cli.count("const doneKey = context.openclawSessionKey") == 1
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
