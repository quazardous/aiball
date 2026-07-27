#!/usr/bin/env bash
# Thin launcher for the SessionStart hook. SB_INSTALL_ROOT is set by the
# state-dir env file (which the hook config sources before exec'ing claude).
# Fallback: resolve from the script's own path assuming the
# config/sandbox-hooks/ layout in a clone or symlinked install (still two
# levels below the root, so the `../..` below is unchanged).
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
exec npx --no-install tsx "$SB_INSTALL_ROOT/src/sandbox/hook-session-start.ts"
