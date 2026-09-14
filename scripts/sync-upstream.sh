#!/usr/bin/env bash
# Rebase this fork's patch stack onto a newer upstream release.
#
#   scripts/sync-upstream.sh            # newest upstream v* tag
#   scripts/sync-upstream.sh v1.6.0     # a specific tag
#
# Steps:
#   1. fetch upstream tags
#   2. snapshot our patches as .patch files under /tmp (to hand to a human/AI on conflict)
#   3. show what upstream changed
#   4. rebase the current branch onto the target tag
#   5. run scripts/test.sh and tag mine-<version>
#
# See PATCHES.md → "When a sync conflicts".
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" = "HEAD" ]; then
  echo "error: detached HEAD — check out your patch branch first (git checkout mine)" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree not clean — commit or stash first" >&2
  exit 1
fi

git fetch upstream --tags --quiet
current=$(git describe --tags --abbrev=0 --match 'v*' HEAD)
target=${1:-$(git tag -l 'v*' --sort=-v:refname | head -n 1)}
if ! git rev-parse -q --verify "refs/tags/$target" >/dev/null; then
  echo "error: no such tag: $target" >&2
  exit 1
fi
if [ "$current" = "$target" ]; then
  echo "Already based on $target."
  exit 0
fi

snap="/tmp/pi-multi-pass-patches-${current}"
rm -rf "$snap"
mkdir -p "$snap"
git format-patch --quiet -o "$snap" "$current..HEAD" >/dev/null

echo "== our patches on $current  (saved to $snap)"
git log --oneline "$current..HEAD" | sed 's/^/   /'
echo
echo "== upstream $current..$target"
git log --oneline "$current..$target" | sed 's/^/   /'
echo
echo "== upstream files changed"
git diff --stat "$current" "$target" | sed 's/^/   /'
echo

if ! git rebase "$target"; then
  cat <<EOF

Rebase stopped on a conflict. To resolve (yourself or with an AI), provide:
  1. PATCHES.md                                  intent + hook points of the conflicting patch
  2. $snap/                the original patch files
  3. git diff $current $target -- extensions/multi-sub.ts     what upstream changed

Re-apply the *intent*, then:
  scripts/test.sh && git add -A && git rebase --continue
or bail out with:
  git rebase --abort
When finished:
  git tag -f mine-${target#v} && git push -f origin $branch --tags
EOF
  exit 1
fi

scripts/test.sh
git tag -f "mine-${target#v}" >/dev/null
echo
echo "Done: $branch = $target + our patches  (tag mine-${target#v})"
echo "Push with:  git push -f origin $branch --tags"
