#!/usr/bin/env bash
# Thin bash wrapper for src/notify/hook-stop.ts (#B.99 follow-up).
# Wired into Claude Code's `Stop` hook via ~/.claude/settings.json
# (run `aiball install-stop-hook` or copy the snippet from the
# install footer). Never blocks Claude due to a hook failure.
set -eo pipefail

SELF="$0"
while [[ -L "$SELF" ]]; do
    target="$(readlink "$SELF")"
    if [[ "$target" = /* ]]; then SELF="$target"; else SELF="$(dirname "$SELF")/$target"; fi
done
INSTALL_ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
cd "$INSTALL_ROOT"
exec npx --no-install tsx "$INSTALL_ROOT/src/notify/hook-stop.ts"
