#!/usr/bin/env bash
# Every heavy test run, in Docker, off the live host's budget.
#
#   bash tests/run-docker.sh unit [files...]   the unit suite (`npm test`), or only the given files
#   bash tests/run-docker.sh e2e               the business-API scenarios (tests/scenario-*.ts)
#   bash tests/run-docker.sh sim [scenario...] the board simulator's scenarios (tests/sim/scenarios)
#   bash tests/run-docker.sh all               unit, then e2e, then sim; exit code = worst
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

run_sim() {
    echo "=== sim ==="
    local code=0
    nice -n 10 npm run --silent sim -- run "$@" || code=$?
    nice -n 10 npm run --silent sim -- down || true
    return $code
}

what="${1:-}"
[ "$#" -gt 0 ] && shift
case "$what" in
    unit) run_unit "$@" ;;
    e2e) run_e2e ;;
    sim) run_sim "$@" ;;
    all)
        code=0
        run_unit || code=1
        run_e2e || code=1
        run_sim || code=1
        exit $code
        ;;
    *)
        sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac
