#!/usr/bin/env bash
# #981 Slice 1 — boot the REAL claude-loop stack driving fake-claude against the
# `daemon` service, then keep the container alive while the loop runs in tmux.
#
# Token bootstrap (test shortcut) : the agent mints its own agent-token directly
# into the SHARED daemon DB volume (/data) — a one-off admin action. AFTER that
# the loop is pure data-plane-remote over HTTP (AIBALL_URL), never touching the
# DB. Slice 2 may move the mint daemon-side; for Slice 1 this keeps `up`
# self-contained (no external orchestrator).
set -euo pipefail
cd /app

DAEMON_URL="${AIBALL_URL:?AIBALL_URL required}"
CONSUMER="${AGENT_CONSUMER:-test-agent}"
PROJECT="${AGENT_PROJECT:-bidon}"
SCENARIO="${AGENT_SCENARIO:-quick-prompt}"
NAME="${AGENT_NAME:-agent1}"
SCENARIO_PATH="/app/examples/fake-claude/scenarios/${SCENARIO}.yaml"

echo "[agent] waiting for daemon at ${DAEMON_URL} ..."
ok=0
for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "${DAEMON_URL}/api/health"; then ok=1; break; fi
    sleep 2
done
[ "$ok" = "1" ] || { echo "[agent] daemon never became healthy"; exit 1; }

echo "[agent] minting agent token (consumer=${CONSUMER}) into shared DB ..."
TOKEN="$(AIBALL_HOME=/data npx tsx /app/tests/mint-agent-token.ts "$CONSUMER")"
[ -n "$TOKEN" ] || { echo "[agent] token mint failed"; exit 1; }
echo "[agent] token minted (${#TOKEN} chars)"

# fake-claude = the only faked component. Default TUI mode (textual) so the pane
# stays alive and renders the markers the loop's pane-probe regexes match — the
# realistic path, not --probe-mode (that's the sync pytest one-shot).
export CL_CLAUDE_CMD="python3 /app/bin/fake-claude ${SCENARIO_PATH}"
export AIBALL_HOME=/agent-state
export AIBALL_SOCK=""
export TERM="${TERM:-xterm-256color}"

echo "[agent] starting claude-loop '${NAME}' (scenario=${SCENARIO}) → ${DAEMON_URL} as ${CONSUMER}/${PROJECT}"
# NOTE: do NOT pass `--check-cmd false`. An explicit check-cmd routes the timer
# to the legacy `mainPoll` loop (state.ts isInternalCheckCmd), which has NONE of
# the boot/pane/compacting machinery: no BootMachine, no pane probe, no loop.sock
# → `inspect` falls back to local zeros and the bar is frozen at the cli seed.
# The default empty check-cmd is the internal/SSE mode (`mainSse`) that the real
# loop runs — that's the only mode worth full-stack testing.
/app/bin/claude-loop start "$NAME" \
    --interval 5 --no-wait --no-attach \
    --aiball-url "$DAEMON_URL" --aiball-token "$TOKEN" \
    --consumer "$CONSUMER" --project "$PROJECT"

echo "[agent] loop spawned (tmux + timer + proxy detached) — holding container alive"
# The tmux server, timer and PTY proxy run detached ; keep PID 1 alive so the
# container stays up. Healthcheck = `claude-loop inspect ${NAME}`.
exec sleep infinity
