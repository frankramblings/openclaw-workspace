#!/usr/bin/env bash
# Prepare a CLEAN, single-commit branch to publish, WITHOUT touching main.
#
# Why: the working tree is scrubbed of private identifiers, but old commits on
# main still contain them. This builds an orphan `public` branch with exactly one
# commit of the current tree — no history, nothing to leak — and leaves `main`
# (your full local history) alone. Push `public` as the public repo's default.
#
# It refuses to run if a secret/identifier scan finds anything, or if private
# files are tracked.
#
# Usage:
#   scripts/prepare-public.sh                 # confirms, then builds `public`
#   scripts/prepare-public.sh --yes           # no prompt
#   scripts/prepare-public.sh --branch foo     # name the branch (default: public)
#   scripts/prepare-public.sh --check         # run the pre-publish checks and exit, build nothing
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BRANCH="public"; ASSUME_YES=0; CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ -e .git ]] || { echo "not a git repo" >&2; exit 1; }

echo "── pre-publish checks ───────────────────────────────────"

# 1. No private identifiers in the tracked tree (shared scanner; extend
#    scripts/publish-scan-patterns.txt, never this file).
if ! hits="$(scripts/publish-scan.sh)"; then
  echo "✗ tracked files still contain private identifiers:" >&2
  echo "$hits" | head -40 >&2
  echo "   fix these (or update the scrub) before publishing." >&2
  exit 1
fi
echo "  ok   no private identifiers in tracked files"

# 2. Private/generated files must not be tracked.
for bad in '.data/' 'frontend/' '.env'; do
  if git ls-files --error-unmatch "$bad" >/dev/null 2>&1 \
     || [[ -n "$(git ls-files "$bad" 2>/dev/null)" ]]; then
    echo "✗ $bad is tracked — it must stay gitignored" >&2; exit 1
  fi
done
echo "  ok   .data/ frontend/ .env not tracked"

# 3. Clean working tree (so the snapshot is intentional).
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ working tree not clean — commit or stash first" >&2
  git status --short >&2; exit 1
fi
echo "  ok   working tree clean"

if [[ "$CHECK" == 1 ]]; then echo "✓ pre-publish checks passed (--check, nothing built)"; exit 0; fi

echo "─────────────────────────────────────────────────────────"
echo "This will (re)create the orphan branch '$BRANCH' as ONE commit of the"
echo "current tree. Your '$(git rev-parse --abbrev-ref HEAD)' branch is untouched."
if [[ "$ASSUME_YES" != 1 ]]; then
  printf "Proceed? [y/N]: "; read -r ans; [[ "$ans" == [yY]* ]] || { echo "aborted"; exit 0; }
fi

SRC_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
# The snapshot is built entirely in a TEMPORARY INDEX. The working tree and
# HEAD are never touched: an earlier version checked out an orphan branch and
# `rm -rf`d the internal trees, which deleted gitignored working files (all of
# docs/superpowers/) for good. `git read-tree HEAD` snapshots the COMMITTED
# tree, which the clean-tree check above already guarantees equals the working
# tree.
TMP_INDEX="$(mktemp)"
trap 'rm -f "$TMP_INDEX"' EXIT
GIT_INDEX_FILE="$TMP_INDEX" git read-tree HEAD
# 3a. Drop internal dev-planning docs from the public snapshot.
#     docs/superpowers/ (and the other internal trees below) contain planning/spec
#     files with maintainer paths and tailnet names. The curated public docs
#     (README, LICENSE, docs/ARCHITECTURE.md, etc.) are kept; only the internal
#     working-docs subtrees are removed.
for internal in docs/superpowers ralph RALPH.md docs/plans docs/thrifty; do
  GIT_INDEX_FILE="$TMP_INDEX" git rm -r -q --cached --ignore-unmatch "$internal" >/dev/null 2>&1 || true
done
TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"
COMMIT="$(git commit-tree "$TREE" -m "OpenClaw Workspace: initial public release")"
git branch -f "$BRANCH" "$COMMIT"

echo
echo "✓ built single-commit branch '$BRANCH' (you never left '$SRC_BRANCH'; nothing on disk changed)."
echo "  Inspect:  git log --oneline $BRANCH ; git ls-files | wc -l"
echo "  Publish:  git push <your-remote> $BRANCH:main"
echo "  (or set '$BRANCH' as the default branch on the remote.)"
