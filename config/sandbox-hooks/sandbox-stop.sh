#!/usr/bin/env bash
set -eo pipefail

if [[ -z "${SB_INSTALL_ROOT:-}" ]]; then
    SELF="$0"
    while [[ -L "$SELF" ]]; do
        target="$(readlink "$SELF")"
        if [[ "$target" = /* ]]; then SELF="$target"; else SELF="$(dirname "$SELF")/$target"; fi
    done
    SB_INSTALL_ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
fi
cd "$SB_INSTALL_ROOT"
exec npx --no-install tsx "$SB_INSTALL_ROOT/src/sandbox/hook-stop.ts"
