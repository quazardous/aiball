#!/usr/bin/env bash
# Bootstrap a deterministic tmux/psmux session for the POC.
# Creates session `cursor-poc` (80x24), fills it with a few rows of
# colored content, leaves the cursor on row 18 (0-based), columns ~3.
# Trailing rows 19..23 remain empty — matching the failure case the
# original ticket #531 was reported against (claude's prompt area with
# blank rows below).

set -euo pipefail

MUX="${MUX_CMD:-tmux}"
SESSION="${TARGET:-cursor-poc}"

if "${MUX}" has-session -t "${SESSION}" 2>/dev/null; then
    echo "(${MUX}) session '${SESSION}' already exists — kill it first if you want a fresh one:"
    echo "    ${MUX} kill-session -t ${SESSION}"
    exit 0
fi

# Detached session, 80x24 pane.
"${MUX}" new-session -d -s "${SESSION}" -x 80 -y 24 "bash -l"

# Give the shell a moment to render its prompt.
sleep 0.4

# Send some content + a few colored lines + a fake prompt, leaving the
# cursor on row 18-ish with blank rows trailing.
"${MUX}" send-keys -t "${SESSION}" 'clear' Enter
sleep 0.2
"${MUX}" send-keys -t "${SESSION}" 'echo -e "\033[0;32mPOC #531 — capture-pane cursor landing\033[0m"' Enter
"${MUX}" send-keys -t "${SESSION}" 'echo' Enter
"${MUX}" send-keys -t "${SESSION}" 'for i in 1 2 3 4 5 6 7 8 9; do echo "line $i with descenders like g p y j q" ; done' Enter
"${MUX}" send-keys -t "${SESSION}" 'echo' Enter
"${MUX}" send-keys -t "${SESSION}" 'echo -e "\033[1;34m> claude prompt (cursor should land here)\033[0m"' Enter

sleep 0.2

echo "OK — session '${SESSION}' is running with ${MUX}."
echo
echo "Cursor right now :"
"${MUX}" display-message -p -t "${SESSION}" '#{cursor_x},#{cursor_y}'
echo
echo "Next steps :"
echo "  1. node serve.js                           # default tmux"
echo "  2. open http://localhost:7777/repro in a browser"
echo "  3. (optionnel) curl localhost:7777/tail   # raw tail of capture"
echo
echo "When done :  ${MUX} kill-session -t ${SESSION}"
