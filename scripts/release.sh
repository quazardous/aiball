#!/usr/bin/env bash
#
# release.sh — tag the current version and hand off to CI.
#
# Precondition: you've already bumped package.json, moved the [Unreleased]
# bullets under a dated ## [X.Y.Z] header in CHANGELOG.md, and committed +
# pushed that on main. This script does the LAST mile only — it never bumps
# or commits, so it's safe to run on the live-runtime checkout.
#
# What it does, from the version in package.json:
#   1. sanity-checks (clean tree, tag absent, CHANGELOG section present)
#   2. creates an annotated tag vX.Y.Z and pushes it
#
# Pushing the tag is what triggers `.github/workflows/release.yml`, which
# re-runs these same checks, builds the cl-pty-proxy binaries for Linux and
# Windows, and cuts the GitHub Release with the CHANGELOG section as its notes.
# There is deliberately only one way to publish a Release — this script does
# not call `gh release create`.
#
# Usage:  scripts/release.sh            # tag + push for package.json version
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
  echo "(dry-run) would: git tag -a ${TAG} && git push origin ${TAG}"
  echo "(dry-run) the push would then trigger .github/workflows/release.yml"
  exit 0
fi

# 2. tag + push --------------------------------------------------------------
# The push is the release trigger: CI takes it from here (build + Release).
git tag -a "${TAG}" -m "aiball ${VERSION}"
git push origin "${TAG}"

echo "✓ pushed ${TAG} — CI is now building the release"
echo "  watch: gh run watch \$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
