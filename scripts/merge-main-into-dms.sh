#!/usr/bin/env bash
# Merge origin/main into origin/dms (CRM → DMS weekly feed).
# Usage: ./scripts/merge-main-into-dms.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Fetching origin"
git fetch origin main dms

if ! git show-ref --verify --quiet refs/remotes/origin/dms; then
  echo "Remote branch origin/dms does not exist. Creating from main…"
  git checkout -B dms origin/main
  git push -u origin dms
  echo "Created origin/dms from main. Done."
  exit 0
fi

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "==> Stashing local changes"
  git stash push -u -m "merge-main-into-dms auto-stash"
  STASHED=1
fi

echo "==> Checking out dms"
git checkout dms
git pull --ff-only origin dms

echo "==> Merging origin/main into dms"
if git merge origin/main --no-edit; then
  echo "==> Pushing dms"
  git push origin dms
  echo "OK: main → dms complete."
else
  echo ""
  echo "CONFLICT: resolve files, then:"
  echo "  git add -A && git commit && git push origin dms"
  echo "Prefer CRM (main) behavior for sales/credit/quote UI."
  exit 1
fi

if [[ "$CURRENT" != "dms" ]]; then
  git checkout "$CURRENT"
fi
if [[ "$STASHED" -eq 1 ]]; then
  git stash pop || true
fi
