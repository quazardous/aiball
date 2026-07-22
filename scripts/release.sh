#!/usr/bin/env bash
#
# release.sh — tag the current version and publish a GitHub Release.
#
# Precondition: you've already bumped package.json, moved the [Unreleased]
# bullets under a dated ## [X.Y.Z] header in CHANGELOG.md, and committed +
# pushed that on main. This script does the LAST mile only — it never bumps
# or commits, so it's safe to run on the live-runtime checkout.
#
# What it does, from the version in package.json:
#   1. sanity-checks (clean tree, on the release commit, tag absent, section present)
#   2. creates an annotated tag vX.Y.Z and pushes it
#   3. cuts a GitHub Release whose notes are the CHANGELOG section for X.Y.Z
#
# Usage:  scripts/release.sh            # tag + release for package.json version
#         scripts/release.sh --dry-run  # print what it would do, touch nothing
set -euo pipefail

cd "$(dirname "$0")/.."

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

# 1. sanity checks -----------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ working tree is dirty — commit or stash first." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "✗ tag ${TAG} already exists. Nothing to do (bump package.json for a new release)." >&2
  exit 1
fi

# Extract the CHANGELOG section for this version (between its header and the next ## [ ).
NOTES="$(awk -v ver="## [${VERSION}]" '
  index($0, ver) == 1 { grab = 1; next }
  grab && /^## \[/     { exit }
  grab                 { print }
' CHANGELOG.md)"

if [[ -z "${NOTES//[[:space:]]/}" ]]; then
  echo "✗ no CHANGELOG section '## [${VERSION}]' found (or it's empty)." >&2
  echo "  Move the [Unreleased] bullets under a dated '## [${VERSION}] — YYYY-MM-DD' header first." >&2
  exit 1
fi

echo "→ version ${VERSION}  tag ${TAG}"
echo "→ release notes:"
echo "${NOTES}" | sed 's/^/    /'

if [[ "$DRY" == 1 ]]; then
  echo "(dry-run) would: git tag -a ${TAG} && git push origin ${TAG} && gh release create ${TAG}"
  exit 0
fi

# 2. tag + push --------------------------------------------------------------
git tag -a "${TAG}" -m "aiball ${VERSION}"
git push origin "${TAG}"

# 3. GitHub Release ----------------------------------------------------------
printf '%s\n' "${NOTES}" | gh release create "${TAG}" --title "${TAG}" --notes-file -

echo "✓ released ${TAG}"
