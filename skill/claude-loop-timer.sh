#!/usr/bin/env bash
# claude-loop timer pane (#B.63 v1) — polls every CL_INTERVAL seconds.
# When claude is idle (idle-since marker present) AND CL_CHECK_CMD
# reports a new event (exit 0) OR a manual wake was requested, picks
# a random phrase from CL_PINGS and `tmux send-keys` it into pane 0.
#
# Pure poll for v1 — sub-minute reactivity is v2 (swap to a unix
# socket the check process writes to instead of polling).
set -eo pipefail

CL_INTERVAL="${CL_INTERVAL:-60}"
CL_CHECK_CMD="${CL_CHECK_CMD:-true}"
CL_NAME="${CL_NAME:?CL_NAME required}"
CL_STATE_DIR="${CL_STATE_DIR:?CL_STATE_DIR required}"
CL_PINGS="${CL_PINGS:?CL_PINGS required}"
TNAME="cl-$CL_NAME"

pick_ping() {
    # Pulls all `- "..."` lines out of the ping_messages list. Strips
    # quotes. Picks one at random. yq would be cleaner but bash + awk
    # avoids a runtime dep.
    awk '
        /^ping_messages:/ { inlist=1; next }
        inlist && /^[a-zA-Z_]+:/ { inlist=0 }
        inlist && /^  *-/ {
            sub(/^  *-[ \t]*/, "")
            gsub(/^"|"$/, "")
            print
        }
    ' "$CL_PINGS" | shuf -n 1
}

echo "[claude-loop:$CL_NAME] timer started — poll every ${CL_INTERVAL}s; check: ${CL_CHECK_CMD}"

while tmux has-session -t "$TNAME" 2>/dev/null; do
    sleep "$CL_INTERVAL"
    # Only do anything if claude is idle.
    [[ -f "$CL_STATE_DIR/idle-since" ]] || continue

    # Manual wake bypass: a `wake-requested` marker forces a tick
    # without consulting the check-cmd (useful when the trigger lives
    # outside what check-cmd knows about).
    if [[ -f "$CL_STATE_DIR/wake-requested" ]]; then
        rm -f "$CL_STATE_DIR/wake-requested"
        rm -f "$CL_STATE_DIR/idle-since"
        phrase="$(pick_ping)"
        [[ -z "$phrase" ]] && phrase="ping"
        tmux send-keys -t "$TNAME.0" "$phrase" Enter
        echo "[claude-loop:$CL_NAME] manual wake → '$phrase'"
        continue
    fi

    # Run the check-cmd. Exit 0 = new event present, anything else =
    # nothing to do. The cmd inherits the env file's vars.
    if bash -c "$CL_CHECK_CMD" >/dev/null 2>&1; then
        rm -f "$CL_STATE_DIR/idle-since"
        phrase="$(pick_ping)"
        [[ -z "$phrase" ]] && phrase="ping"
        tmux send-keys -t "$TNAME.0" "$phrase" Enter
        echo "[claude-loop:$CL_NAME] check-cmd hit → '$phrase'"
    fi
done

echo "[claude-loop:$CL_NAME] tmux session gone — timer exiting"
