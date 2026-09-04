#!/usr/bin/env bash
# Scan the TRACKED tree for private identifiers. Exit 0 and print nothing when
# clean; exit 1 and print path:line:text for every hit. Shared by
# prepare-public.sh (--check and the real build) and backend/tests/test_publish_scan.py,
# so the publish gate and the test suite can never disagree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PATTERN="$(grep -v '^\s*$' scripts/publish-scan-patterns.txt | paste -sd'|' -)"
# Trees that are never published (dropped by prepare-public.sh) or third-party:
PUBLISH_EXCLUDES=(
  ':!docs/superpowers/' ':!docs/SHIPPING.md' ':!scripts/prepare-public.sh'
  ':!scripts/publish-scan.sh' ':!scripts/publish-scan-patterns.txt'
  ':!frontend-vendor/' ':!ralph/' ':!RALPH.md' ':!docs/plans/' ':!docs/thrifty/'
)
# git grep: 0 = matches found (dirty), 1 = no matches (clean), 2+ = a real
# error (bad pattern, unreadable repo). Never report an error as "clean".
set +e
hits="$(git grep -nIE "$PATTERN" -- . "${PUBLISH_EXCLUDES[@]}" 2>&1)"
rc=$?
set -e
if [[ "$rc" -eq 0 ]]; then
  printf '%s\n' "$hits"
  exit 1
fi
if [[ "$rc" -ge 2 ]]; then
  echo "publish scan could not run (git grep exit $rc):" >&2
  printf '%s\n' "$hits" >&2
  exit 2
fi
exit 0
