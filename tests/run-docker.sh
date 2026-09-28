#!/usr/bin/env bash
# Every heavy test run, in Docker, off the live host's budget.
#
#   bash tests/run-docker.sh unit [files...]   the unit suite (`npm test`), or only the given files
#   bash tests/run-docker.sh e2e               the business-API scenarios (tests/scenario-*.ts)
#   bash tests/run-docker.sh sim [scenario...] the board simulator's scenarios (tests/sim/scenarios)
#   bash tests/run-docker.sh fullstack         a real claude-loop driving fake-claude against a real
#                                              daemon (tests/integration/fullstack): the loop kernel
#   bash tests/run-docker.sh checks            what CI checks besides the tests: typecheck, lint, the
#                                              frontend's unit tests, and the frontend build in an
#                                              install of the frontend's dependencies alone
#   bash tests/run-docker.sh critical          before every deploy: checks, unit, e2e, fullstack, and the
#                                              simulator's scenarios marked `critical: true`;
#                                              exit code = worst
#   bash tests/run-docker.sh full              before a release or after a large change: unit, e2e,
#                                              fullstack and every scenario (`all` is the same)
#
# The simulator plays its scenarios over AIBALL_SIM_SHARDS boards side by side
# (default 4), each capped at AIBALL_SIM_CPUS cores (default 2).
#
# Each container is capped at AIBALL_TEST_CPUS cores (default 4) and the docker
# client runs under `nice`: the live daemon and loops on the same machine keep
# the upper hand. The unit container has no network and a read-only source.
#
#   AIBALL_TEST_CPUS=2 bash tests/run-docker.sh unit
#   AIBALL_TEST_SRC=/path/to/other/checkout bash tests/run-docker.sh unit
set -uo pipefail
cd "$(dirname "$0")/.."

export AIBALL_TEST_CPUS="${AIBALL_TEST_CPUS:-4}"
if [ -n "${AIBALL_TEST_SRC:-}" ]; then
    AIBALL_TEST_SRC="$(cd "$AIBALL_TEST_SRC" && pwd)" || { echo "AIBALL_TEST_SRC: no such directory"; exit 2; }
    export AIBALL_TEST_SRC
fi
# The unit suite has hung before (see ci.yml): never let it hold a core forever.
UNIT_TIMEOUT="${AIBALL_TEST_UNIT_TIMEOUT:-900}"

compose() { nice -n 10 docker compose -p aiball-tests -f tests/docker-compose.yml --profile tests "$@"; }

run_unit() {
    echo "=== unit (cpus=$AIBALL_TEST_CPUS, src=${AIBALL_TEST_SRC:-.}) ==="
    compose build tests || return 1
    local cmd=(npm test)
    if [ "$#" -gt 0 ]; then
        cmd=(node --import tsx --import ./src/tests/setup-isolation.ts --test "$@")
    fi
    timeout --foreground "$UNIT_TIMEOUT" nice -n 10 docker compose -p aiball-tests -f tests/docker-compose.yml \
        --profile tests run --rm tests "${cmd[@]}"
}

run_e2e() {
    # Another stack on the machine may hold the default port: take a free one.
    if [ -z "${AIBALL_TEST_PORT:-}" ]; then
        local p
        for p in $(seq 17791 17899); do
            if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then export AIBALL_TEST_PORT=$p; break; fi
        done
    fi
    echo "=== e2e (port ${AIBALL_TEST_PORT:-17777}) ==="
    nice -n 10 bash tests/run-e2e.sh
}

# #3093 — nothing else runs the loop kernel: e2e drives the API, the simulator
# drives agents through their MCP tools. These put a real claude-loop, its proxy
# and its hooks against a real daemon, and check a wake goes all the way through.
run_fullstack() {
    local src="${AIBALL_TEST_SRC:-$PWD}" code=0 f
    if [ -z "${AIBALL_TEST_PORT:-}" ]; then
        local p
        for p in $(seq 17911 17999); do
            if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then export AIBALL_TEST_PORT=$p; break; fi
        done
    fi
    echo "=== fullstack (port ${AIBALL_TEST_PORT}, from $src) ==="
    for f in smoke golden-path golden-path-host; do
        (cd "$src" && nice -n 10 tests/integration/run_fullstack.py "tests/integration/fullstack/$f.yaml") || code=1
    done
    return $code
}

# #3240 — CI's other checks, before a deploy rather than after a push: the
# typecheck, the lint and the frontend's tests in the unit image; the frontend
# build in an image that has the frontend's dependencies only, as CI does.
run_checks() {
    echo "=== checks (typecheck, lint, frontend tests, frontend build) ==="
    compose build tests frontend || return 1
    local code=0
    nice -n 10 docker compose -p aiball-tests -f tests/docker-compose.yml --profile tests run --rm tests \
        sh -c "npm run typecheck && npm run lint && npm run test:frontend" || code=1
    nice -n 10 docker compose -p aiball-tests -f tests/docker-compose.yml --profile tests run --rm frontend || code=1
    return $code
}

run_sim() {
    local shards="${AIBALL_SIM_SHARDS:-4}"
    local src="${AIBALL_TEST_SRC:-$PWD}"
    echo "=== sim (shards=$shards, cpus=${AIBALL_SIM_CPUS:-2} each, from $src) ==="
    local code=0
    # The driver and its scenarios come from the source under test too, not only
    # the daemon: run from this checkout, a scratch copy's boards were driven by
    # the checkout's older scenarios and passed what they should have failed.
    (cd "$src" && AIBALL_TEST_CPUS="${AIBALL_SIM_CPUS:-2}" nice -n 10 npm run --silent sim -- run --shards "$shards" "$@") || code=$?
    (cd "$src" && nice -n 10 npm run --silent sim -- down) || true
    return $code
}

# Run a phase and say how long it took, so a profile's budget is measured, not guessed.
timed() {
    local start=$SECONDS code=0
    "$@" || code=$?
    echo "=== $1: $((SECONDS - start)) s ==="
    return $code
}

what="${1:-}"
[ "$#" -gt 0 ] && shift
case "$what" in
    unit) run_unit "$@" ;;
    e2e) run_e2e ;;
    sim) run_sim "$@" ;;
    fullstack) run_fullstack ;;
    checks) run_checks ;;
    critical)
        code=0
        timed run_checks || code=1
        timed run_unit || code=1
        timed run_e2e || code=1
        timed run_fullstack || code=1
        timed run_sim --critical || code=1
        echo "=== critical profile: ${SECONDS} s ==="
        exit $code
        ;;
    full|all)
        code=0
        timed run_checks || code=1
        timed run_unit || code=1
        timed run_e2e || code=1
        timed run_fullstack || code=1
        timed run_sim || code=1
        echo "=== full profile: ${SECONDS} s ==="
        exit $code
        ;;
    *)
        sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac
