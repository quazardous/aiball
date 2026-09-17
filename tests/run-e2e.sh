#!/usr/bin/env bash
# #324 e2e runner: bring up the daemon container, run the scenario(s) inside it
# (shared DB for token minting + localhost API), then tear down. Exit code is
# the scenario's. Run from anywhere: `bash tests/run-e2e.sh`.
set -uo pipefail
cd "$(dirname "$0")/.."

compose() { docker compose -f tests/docker-compose.yml "$@"; }
# The compose file publishes the daemon on AIBALL_TEST_PORT; wait on that same port.
PORT="${AIBALL_TEST_PORT:-17777}"

# Only the daemon: the scenarios run inside it and never talk to the agent service.
compose up -d --build daemon

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
code=0
for s in tests/scenario-*.ts; do
    echo "=== $(basename "$s") ==="
    if ! compose exec -T daemon npx tsx "$s"; then code=1; fi
done

compose down -v
exit $code
