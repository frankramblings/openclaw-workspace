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
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BRANCH="public"; ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ -d .git ]] || { echo "not a git repo" >&2; exit 1; }

echo "── pre-publish checks ───────────────────────────────────"

# 1. No private identifiers in the tracked tree. Extend this list as needed.
PATTERNS='femanuele|wistia|bespin|bicolor-triceratops|skinny-cloths|/Users/[a-z]'
# docs/superpowers/ is excluded: it contains dev-planning artifacts (paths,
# tailnet names) that are internal only — they are dropped from the public
# branch below (step 3a), so they don't need to pass this scan.
if hits="$(git grep -nIE "$PATTERNS" -- . \
    ':!docs/superpowers/' \
    ':!docs/SHIPPING.md' \
    ':!scripts/prepare-public.sh' 2>/dev/null)"; then
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

echo "─────────────────────────────────────────────────────────"
echo "This will (re)create the orphan branch '$BRANCH' as ONE commit of the"
echo "current tree. Your '$(git rev-parse --abbrev-ref HEAD)' branch is untouched."
if [[ "$ASSUME_YES" != 1 ]]; then
  printf "Proceed? [y/N]: "; read -r ans; [[ "$ans" == [yY]* ]] || { echo "aborted"; exit 0; }
fi

SRC_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git checkout --orphan "__public_tmp" >/dev/null 2>&1
git add -A
# 3a. Drop internal dev-planning docs from the public snapshot.
#     docs/superpowers/ contains planning/spec files with maintainer paths and
#     tailnet names. The curated public docs (README, LICENSE, docs/ARCHITECTURE.md,
#     etc.) are kept; only the internal working-docs subtree is removed.
if [[ -d docs/superpowers ]]; then
  git rm -r --cached docs/superpowers >/dev/null 2>&1 || true
  rm -rf docs/superpowers
fi
git commit -q -m "OpenClaw Workspace — initial public release"
git branch -D "$BRANCH" >/dev/null 2>&1 || true
git branch -m "$BRANCH"
git checkout "$SRC_BRANCH" >/dev/null 2>&1

echo
echo "✓ built single-commit branch '$BRANCH' (back on '$SRC_BRANCH')."
echo "  Inspect:  git log --oneline $BRANCH ; git ls-files | wc -l"
echo "  Publish:  git push <your-remote> $BRANCH:main"
echo "  (or set '$BRANCH' as the default branch on the remote.)"
