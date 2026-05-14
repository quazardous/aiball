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
cd "$INSTALL_ROOT"
exec npx --no-install tsx "$INSTALL_ROOT/src/autopoll/hook-stop.ts"
