#!/usr/bin/env bash
# claude-loop Stop hook (#B.63 v1) — runs at the end of every Claude
# turn. Writes `idle-since` in the state dir so the timer pane knows
# claude is at the prompt. Reads CL_STATE_DIR from the env file
# sourced by the wrapper before claude was spawned.
#
# Exits 0 with empty stdout = lets claude stop. The wake-up is the
# timer's job, not ours.
set -eo pipefail
trap 'echo "{}"; exit 0' ERR

if [[ -z "${CL_STATE_DIR:-}" ]]; then
    # Hook fired outside a claude-loop session — silent no-op.
    echo "{}"
    exit 0
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$CL_STATE_DIR/idle-since"
echo "{}"
