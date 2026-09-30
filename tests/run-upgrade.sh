#!/usr/bin/env bash
# The upgrade test (tests/upgrade/upgrade.sh), in a throwaway container: the
# latest release installed, used, then updated to this checkout's HEAD.
#
#   bash tests/run-upgrade.sh
#   AIBALL_TEST_SRC=/path/to/other/checkout bash tests/run-upgrade.sh
#   AIBALL_UPGRADE_BASE=v0.51.0 bash tests/run-upgrade.sh   # from another release
#
# Needs the network (npm installs the dependencies of both versions) and a
# checkout with its tags and its commits: HEAD, not the working tree, is tested.
set -euo pipefail
cd "$(dirname "$0")/.."
src="${AIBALL_TEST_SRC:-$PWD}"
docker build -q -t aiball-test-upgrade:local -f tests/upgrade/Dockerfile tests/upgrade > /dev/null
exec nice -n 10 docker run --rm --cpus "${AIBALL_TEST_CPUS:-4}" \
    -e AIBALL_UPGRADE_BASE="${AIBALL_UPGRADE_BASE:-}" \
    -v "$src":/src:ro \
    aiball-test-upgrade:local
