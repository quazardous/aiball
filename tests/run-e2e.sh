#!/usr/bin/env bash
# #324 e2e runner: bring up the daemon container, run the scenario(s) inside it
# (shared DB for token minting + localhost API), then tear down. Exit code is
# the scenario's. Run from anywhere: `bash tests/run-e2e.sh`.
set -uo pipefail
cd "$(dirname "$0")/.."

# #3380 — with the run's shared node_modules volumes when run-docker.sh made them.
if [ -n "${AIBALL_TEST_NM:-}" ]; then
    export AIBALL_TEST_NET="${COMPOSE_PROJECT_NAME:-tests}-net"
    docker network inspect "$AIBALL_TEST_NET" >/dev/null 2>&1 || docker network create "$AIBALL_TEST_NET" >/dev/null
    compose() { docker compose -f tests/docker-compose.yml -f tests/docker-compose.nm.yml "$@"; }
else
    compose() { docker compose -f tests/docker-compose.yml "$@"; }
fi
# The compose file publishes the daemon on AIBALL_TEST_PORT; wait on that same port.
PORT="${AIBALL_TEST_PORT:-17777}"

# Only the daemon: the scenarios run inside it and never talk to the agent service.
# #3380 — AIBALL_TEST_PREBUILT: the images were built once for the whole run.
if [ -n "${AIBALL_TEST_PREBUILT:-}" ]; then compose up -d --no-build daemon; else compose up -d --build daemon; fi

# wait for the daemon to be healthy (public /api/health)
ok=0
for _ in $(seq 1 30); do
    if curl -sf -o /dev/null http://127.0.0.1:${PORT}/api/health; then ok=1; break; fi
    sleep 2
done
if [ "$ok" != "1" ]; then
    echo "daemon did not become healthy"
    compose logs --tail 30 daemon || true
    compose down -v
    exit 1
fi

# scenarios run INSIDE the daemon container (shared DB + localhost daemon).
# Each uses a distinct project, so they don't interfere on the shared daemon.
# One after another: the scenarios run inside the daemon's container and write its
# database file directly, so side by side they lock each other out (#3380).
code=0
for s in tests/scenario-*.ts; do
    echo "=== $(basename "$s") ==="
    if ! compose exec -T daemon npx tsx "$s"; then code=1; fi
done

compose down -v
exit $code
