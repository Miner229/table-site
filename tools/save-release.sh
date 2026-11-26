#!/usr/bin/env bash
# Save the version that is live now as a release (a permanent backup on GitHub).
# Run it right after every push to main:
#
#   tools/save-release.sh "что изменилось"
#
# Creates the tag release-YYYY-MM-DD-HHMM (Aktobe time) on origin/main and pushes only that tag.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
msg="${1:?Usage: tools/save-release.sh \"what changed\"}"

git fetch -q origin
commit=$(git rev-parse origin/main)
if existing=$(git tag --points-at "$commit" -l 'release-*' | head -1) && [ -n "$existing" ]; then
  echo "Already saved: $existing"; exit 0
fi
tag="release-$(date -u -d '+5 hours' +%Y-%m-%d-%H%M)"   # Aktobe = UTC+5, computed explicitly
git tag -a "$tag" "$commit" -m "$msg"
git push -q origin "refs/tags/$tag"
echo "Saved $tag -> $(git rev-parse --short "$commit")"
