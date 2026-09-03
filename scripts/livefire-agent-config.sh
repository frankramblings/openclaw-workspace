#!/usr/bin/env bash
# Live-fire for the Pillar D agent-config backend. Reads are always safe.
# Writes run ONLY with LIVEFIRE_WRITES=1 and against a backend whose
# WORKSPACE_AGENT_CONFIG_WRITES is on: they add a DISABLED probe MCP server,
# toggle it, remove it, and round-trip SOUL.md through a backup + restore.
# Proposal apply/reject are never automated: the pending list and the exact
# commands are printed for a human to pick one.
#
# Usage: scripts/livefire-agent-config.sh [base_url]   (default http://127.0.0.1:8800)
#        LIVEFIRE_WRITES=1 scripts/livefire-agent-config.sh
set -euo pipefail
BASE="${1:-http://127.0.0.1:8800}"
J="python3 -c"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
get() { curl -sS "$BASE$1"; }
post() { curl -sS -X POST "$BASE$1" -H 'content-type: application/json' -d "${2:-{\}}"; }
put() { curl -sS -X PUT "$BASE$1" -H 'content-type: application/json' -d "$2"; }
del() { curl -sS -X DELETE "$BASE$1"; }

echo "== reads against $BASE"
get /api/agent-config/status | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"]; print("status:", d)' || fail status
HASH0=$(get /api/mcp/servers | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"]; print(d["hash"])') || fail mcp-list
get /api/mcp/servers | $J 'import json,sys; d=json.load(sys.stdin); print("mcp:", [(s["id"], s["transport"], s["is_enabled"]) for s in d["servers"]])'
get /api/skill-proposals | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"]; print("proposals:", d["counts"])' || fail proposals
get /api/agent/files | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"]; print("files:", [f["name"] for f in d["files"]])' || fail files
get '/api/logs/tail?limit=3&max_bytes=4000' | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"]; print("log:", d["file"], d["size"])' || fail logs
pass "reads"

if [[ "${LIVEFIRE_WRITES:-0}" != "1" ]]; then
  echo "== writes skipped (set LIVEFIRE_WRITES=1 to run them). Pending proposals and commands:"
  get /api/skill-proposals | $J 'import json,sys; d=json.load(sys.stdin)
for p in d["proposals"]:
    if p["status"] == "pending": print("  %-48s %s" % (p["id"], p["title"]))
print("  apply : curl -X POST '"$BASE"'/api/skill-proposals/<id>/apply  -H content-type:application/json -d \x27{\"reason\":\"...\"}\x27")
print("  reject: curl -X POST '"$BASE"'/api/skill-proposals/<id>/reject -H content-type:application/json -d \x27{\"reason\":\"...\"}\x27")'
  exit 0
fi

echo "== MCP probe server round trip"
post /api/mcp/servers '{"name":"pillar-d-probe","url":"https://example.invalid/mcp","enabled":false}' | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["server"]["is_enabled"] is False, d; print("added, backup", d["backup_id"])' || fail mcp-add
get /api/mcp/servers | $J 'import json,sys; d=json.load(sys.stdin); assert any(s["id"]=="pillar-d-probe" and not s["is_enabled"] for s in d["servers"]), d' || fail mcp-list-after-add
post /api/mcp/servers/pillar-d-probe/enabled '{"enabled":true}' | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["server"]["is_enabled"] is True, d' || fail mcp-enable
post /api/mcp/servers/pillar-d-probe/enabled '{"enabled":false}' | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["server"]["is_enabled"] is False, d' || fail mcp-disable
del /api/mcp/servers/pillar-d-probe | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["removed"]=="pillar-d-probe", d' || fail mcp-remove
get /api/mcp/servers | $J 'import json,sys; d=json.load(sys.stdin); assert not any(s["id"]=="pillar-d-probe" for s in d["servers"]), d' || fail mcp-list-after-remove
get '/api/agent-config/audit?limit=4' | $J 'import json,sys; d=json.load(sys.stdin); acts=[e["action"] for e in d["entries"]]; assert acts==["mcp.remove","mcp.enabled","mcp.enabled","mcp.add"], acts' || fail audit
pass "MCP add/enable/disable/remove (config hash before: $HASH0)"

echo "== SOUL.md backup + restore round trip"
CUR=$(get /api/agent/files/SOUL.md)
SHA=$(echo "$CUR" | $J 'import json,sys; print(json.load(sys.stdin)["file"]["sha256"])')
echo "$CUR" | $J 'import json,sys; d=json.load(sys.stdin); json.dump({"content": d["file"]["content"], "base_sha256": d["file"]["sha256"]}, open("/tmp/pillar-d-soul.json","w"))'
put /api/agent/files/SOUL.md "$(cat /tmp/pillar-d-soul.json)" | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d.get("unchanged") is True, d' || fail soul-unchanged
echo "$CUR" | $J 'import json,sys; d=json.load(sys.stdin); json.dump({"content": d["file"]["content"] + "\n", "base_sha256": d["file"]["sha256"]}, open("/tmp/pillar-d-soul2.json","w"))'
BID=$(put /api/agent/files/SOUL.md "$(cat /tmp/pillar-d-soul2.json)" | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["backup_id"], d; print(d["backup_id"])') || fail soul-write
post /api/agent/files/SOUL.md/restore "{\"backup_id\":\"$BID\"}" | $J 'import json,sys; d=json.load(sys.stdin); assert d["ok"], d' || fail soul-restore
get /api/agent/files/SOUL.md | $J "import json,sys; d=json.load(sys.stdin); assert d['file']['sha256']=='$SHA', d['file']['sha256']" || fail soul-sha-after-restore
rm -f /tmp/pillar-d-soul.json /tmp/pillar-d-soul2.json
pass "SOUL.md write + backup + restore (sha back to $SHA)"
echo "ALL PASS"
