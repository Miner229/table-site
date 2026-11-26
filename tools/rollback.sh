#!/usr/bin/env bash
# Return the site to a saved release — WITHOUT erasing anything.
#
#   tools/rollback.sh                      list saved releases
#   tools/rollback.sh <release-tag>        make a new commit on main whose files are exactly that release
#   tools/rollback.sh <release-tag> --push ...and publish it (GitHub Pages updates in ~1 min)
#
# It never force-pushes and never rewrites history: the rollback is an ordinary new commit,
# so it can itself be undone the same way (roll "back" to the newer release tag).
set -euo pipefail

# the whole script is one function: bash reads it completely before running, so it keeps working
# even when the rollback removes this very file (releases older than the tools)
main() {
  cd "$(git rev-parse --show-toplevel)"

  if [ $# -lt 1 ]; then
    echo "Saved releases (newest last):"
    git tag -l 'release-*' -n1
    exit 0
  fi
  tag="$1"; push="${2:-}"

  git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null || { echo "No release «$tag». Run without arguments to list them."; exit 1; }
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "There are uncommitted changes here — commit or stash them first."; exit 1
  fi

  git fetch -q origin
  git checkout -q main
  git merge -q --ff-only origin/main
  before=$(git rev-parse --short HEAD)

  if git diff --quiet "$tag" HEAD; then echo "main already equals $tag — nothing to do."; exit 0; fi

  # files (and deletions) exactly as in the release; history stays as it is
  git read-tree -u --reset "$tag"
  git commit -q -m "Rollback to $tag

  The site files are restored exactly as in $tag (was $before). Nothing was erased:
  to undo this rollback, roll back to the newer release tag."

  # safety check: the tree must now be identical to the release
  git diff --quiet "$tag" HEAD || { echo "!! files differ from $tag — not pushing"; exit 1; }
  echo "OK: main now equals $tag (new commit $(git rev-parse --short HEAD), was $before)."

  if [ "$push" = "--push" ]; then
    git push -q origin main && echo "Pushed. The site shows $tag in about a minute (Ctrl+F5 on the hall screen)."
  else
    echo "Not pushed yet. To publish:  git push origin main"
  fi
}
main "$@"
