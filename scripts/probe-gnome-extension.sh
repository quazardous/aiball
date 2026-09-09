#!/usr/bin/env bash
# Does the aiball GNOME extension still LOAD on this machine's GNOME Shell?
#
# The extension commits us to a version treadmill: `metadata.json` lists the
# Shell versions it supports, and a major release can break the API under it.
# The failure is silent — the extension simply stops appearing — so the cost of
# that treadmill is only bearable if checking is one command. This is it.
#
# It runs a HEADLESS, throwaway GNOME Shell: no window on your desktop, its own
# dconf and data dir, so your live session and its extension list are untouched.
# Then it asks the shell itself for the extension's state:
#
#   ACTIVE  — it loaded and enable() ran without throwing
#   ERROR   — it did not; the shell log holds the exception
#
# Verified to discriminate: pointing an import at a missing module turns ACTIVE
# into ERROR. A probe that cannot fail would tell you nothing.
#
# What it does NOT check: what the thing LOOKS like. Headless has no screen.
# Placement, the icon and the label still want a human eye once.
#
# Usage: scripts/probe-gnome-extension.sh [path/to/gnome/<uuid>]
set -uo pipefail

UUID="aiball@quazardous.github.io"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$REPO/gnome/$UUID}"

for cmd in gnome-shell gnome-extensions dbus-run-session gsettings; do
    command -v "$cmd" >/dev/null || { echo "missing: $cmd"; exit 2; }
done
[ -f "$SRC/metadata.json" ] || { echo "no extension at $SRC"; exit 2; }

echo "shell   : $(gnome-shell --version)"
echo "declares: $(python3 -c "import json,sys;print(', '.join(json.load(open('$SRC/metadata.json'))['shell-version']))")"

# Short paths on purpose: a Wayland socket path is capped at 108 bytes, and a
# temp dir under a long parent silently fails to bind.
NEST="$(mktemp -d /tmp/ab-probe-XXXXXX)"
trap 'rm -rf "$NEST"' EXIT
mkdir -p "$NEST/data/gnome-shell/extensions" "$NEST/config" "$NEST/run"
chmod 700 "$NEST/run"
cp -r "$SRC" "$NEST/data/gnome-shell/extensions/$UUID"

export XDG_CONFIG_HOME="$NEST/config" XDG_DATA_HOME="$NEST/data" \
       XDG_DATA_DIRS="/usr/local/share:/usr/share" XDG_RUNTIME_DIR="$NEST/run"
unset WAYLAND_DISPLAY DISPLAY

dbus-run-session -- bash -c '
    set -u
    gsettings set org.gnome.shell disable-user-extensions false
    gnome-shell --headless --wayland --wayland-display=ab-probe > "'"$NEST"'/shell.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 30); do
        sleep 1
        gnome-extensions info '"$UUID"' >/dev/null 2>&1 && break
    done
    gnome-extensions enable '"$UUID"' >/dev/null 2>&1
    sleep 4
    gnome-extensions info '"$UUID"' 2>/dev/null | grep -aE "State|État" | tail -1
    kill $pid 2>/dev/null; wait $pid 2>/dev/null
' 2>/dev/null | tee "$NEST/state.txt"

if grep -qa "ACTIVE" "$NEST/state.txt"; then
    echo "verdict : loads and enables cleanly"
    exit 0
fi
echo "verdict : DID NOT LOAD — the shell said:"
grep -a -iE "aiball|JS ERROR" "$NEST/shell.log" | head -20
exit 1
