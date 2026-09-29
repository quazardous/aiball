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
#   bash tests/run-docker.sh critical          before every deploy, side by side: checks, the unit tests
#                                              of backward compatibility and of what changed since
#                                              AIBALL_TEST_BASE (default origin/main), e2e, fullstack
#                                              and the simulator's scenarios marked `critical: true`;
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

compose() {
    local nm=()
    [ -n "${AIBALL_TEST_NM:-}" ] && nm=(-f tests/docker-compose.nm.yml)
    nice -n 10 docker compose -p aiball-tests -f tests/docker-compose.yml "${nm[@]}" --profile tests "$@"
}

run_unit() {
    echo "=== unit (cpus=$AIBALL_TEST_CPUS, src=${AIBALL_TEST_SRC:-.}) ==="
    [ -n "${AIBALL_TEST_PREBUILT:-}" ] || compose build tests || return 1
    # #3380 — as many test files at once as the container has cores: node sees the
    # host's cores, not the cap, and ran 11 files side by side on 4.
    local cmd=(node --import tsx --import ./src/tests/setup-isolation.ts --test
        "--test-concurrency=${AIBALL_TEST_CPUS}" "src/**/*.test.ts")
    if [ "$#" -gt 0 ]; then
        cmd=(node --import tsx --import ./src/tests/setup-isolation.ts --test "--test-concurrency=${AIBALL_TEST_CPUS}" "$@")
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
    # #3380 — its own compose project: another run's stack never collides with it.
    COMPOSE_PROJECT_NAME=aiball-e2e nice -n 10 bash tests/run-e2e.sh
}

# #3093 — nothing else runs the loop kernel: e2e drives the API, the simulator
# drives agents through their MCP tools. These put a real claude-loop, its proxy
# and its hooks against a real daemon, and check a wake goes all the way through.
run_fullstack() {
    local src="${AIBALL_TEST_SRC:-$PWD}" code=0 f p port=17910 out
    echo "=== fullstack (from $src) ==="
    # #3380 — the scenarios side by side, each on its own compose project and
    # port; each one's output printed whole once it is done.
    out="$(mktemp -d)"
    local pids=()
    for f in smoke golden-path golden-path-host; do
        for p in $(seq $((port + 1)) 17999); do
            if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then port=$p; break; fi
        done
        (cd "$src" && COMPOSE_PROJECT_NAME="aiball-fs-$f" AIBALL_TEST_PORT=$port \
            nice -n 10 tests/integration/run_fullstack.py "tests/integration/fullstack/$f.yaml") > "$out/$f.log" 2>&1 &
        pids+=("$!:$f")
    done
    for p in "${pids[@]}"; do
        wait "${p%%:*}" || code=1
        cat "$out/${p#*:}.log"
    done
    rm -rf "$out"
    return $code
}

# #3240 — CI's other checks, before a deploy rather than after a push: the
# typecheck, the lint and the frontend's tests in the unit image; the frontend
# build in an image that has the frontend's dependencies only, as CI does.
run_checks() {
    echo "=== checks (typecheck, lint, frontend tests, frontend build) ==="
    [ -n "${AIBALL_TEST_PREBUILT:-}" ] || compose build tests frontend || return 1
    local code=0
    nice -n 10 docker compose -p aiball-tests -f tests/docker-compose.yml --profile tests run --rm tests \
        sh -c "npm run typecheck && npm run lint && npm run test:frontend" || code=1
    nice -n 10 docker compose -p aiball-tests -f tests/docker-compose.yml --profile tests run --rm frontend || code=1
    return $code
}

run_sim_critical() { run_sim --critical; }

# #3380 — before a deploy, the unit tests of backward compatibility and of what
# changed (tests/select-critical.ts); the whole suite is CI's (`unit`, `full`).
run_unit_critical() {
    local src="${AIBALL_TEST_SRC:-$PWD}" files
    mapfile -t files < <(cd "$src" && node --import tsx tests/select-critical.ts .)
    echo "=== unit, critical selection: ${#files[@]} files (changed since ${AIBALL_TEST_BASE:-origin/main}) ==="
    run_unit "${files[@]}"
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

# #3380 — every image a profile needs, built once before its phases run side by
# side: two phases building the same image at once would race on its tag.
build_images() {
    echo "=== build ==="
    compose build tests frontend daemon agent || return 1
    # The node_modules volumes (tests/docker-compose.nm.yml), named after what
    # fills them and filled once: the first mount of an empty volume copies the
    # image's node_modules into it. The first name is the simulator's own.
    local key key_agent
    key="$(cat package-lock.json tests/Dockerfile | sha256sum | cut -c1-12)"
    key_agent="$(cat package-lock.json tests/Dockerfile.agent | sha256sum | cut -c1-12)"
    export AIBALL_TEST_NM="aiball-sim-nm-$key" AIBALL_TEST_NM_AGENT="aiball-test-nm-agent-$key_agent"
    fill_nm "$AIBALL_TEST_NM" aiball-test-node:local || return 1
    fill_nm "$AIBALL_TEST_NM_AGENT" aiball-test-agent:local || return 1
    # The projects' networks (tests/docker-compose.nm.yml), made once and kept.
    local n
    for n in aiball-e2e aiball-fs-smoke aiball-fs-golden-path aiball-fs-golden-path-host; do
        docker network inspect "$n-net" >/dev/null 2>&1 || docker network create "$n-net" >/dev/null &
    done
    wait
}

fill_nm() {
    docker volume inspect "$1" >/dev/null 2>&1 && return 0
    docker volume create "$1" >/dev/null && docker run --rm --entrypoint true -v "$1:/app/node_modules" "$2"
}

# #3380 — phases side by side, each into its own log, printed whole in turn once
# all are done; the exit code is the worst. `timed` still says each one's time.
parallel_phases() {
    local out code=0 p
    out="$(mktemp -d)"
    local pids=()
    for p in "$@"; do
        timed "$p" > "$out/$p.log" 2>&1 &
        pids+=("$!:$p")
    done
    for p in "${pids[@]}"; do
        wait "${p%%:*}" || code=1
        cat "$out/${p#*:}.log"
    done
    rm -rf "$out"
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
        timed build_images || code=1
        export AIBALL_TEST_PREBUILT=1
        parallel_phases run_checks run_unit_critical run_e2e run_fullstack run_sim_critical || code=1
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
