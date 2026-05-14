#!/usr/bin/env bash
# Thin bash wrapper for src/autopoll/hook-stop.ts (#B.99 follow-up).
# "Autopoll" = aiball polls itself when Claude wants to stop, so the
# agent doesn't have to remember. Wired into Claude Code's `Stop`
# hook via ~/.claude/settings.json (re-run install.sh --stop-hook).
# Never blocks Claude due to a hook failure.
set -eo pipefail

SELF="$0"
while [[ -L "$SELF" ]]; do
    target="$(readlink "$SELF")"
    if [[ "$target" = /* ]]; then SELF="$target"; else SELF="$(dirname "$SELF")/$target"; fi
done
INSTALL_ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"

# Auto-pick the daemon's UDS so the hook reaches aiball without a
# bearer token (same pattern as bin/aiball). Claude Code launches the
# hook with its own minimal env that won't have AIBALL_SOCK or
# AIBALL_TOKEN unless we set them here.
AIBALL_HOME="${AIBALL_HOME:-$HOME/.local/share/aiball}"
if [[ -z "${AIBALL_SOCK:-}" && -S "$AIBALL_HOME/sock" ]]; then
    export AIBALL_SOCK="$AIBALL_HOME/sock"
fi
if [[ -z "${AIBALL_SOCK:-}" && -z "${AIBALL_TOKEN:-}" && -f "$AIBALL_HOME/cli-env" ]]; then
    # shellcheck source=/dev/null
    source "$AIBALL_HOME/cli-env"
fi

cd "$INSTALL_ROOT"
exec npx --no-install tsx "$INSTALL_ROOT/src/autopoll/hook-stop.ts"
