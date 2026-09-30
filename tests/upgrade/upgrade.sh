#!/usr/bin/env bash
# An upgrade, on a machine that already had aiball — what no other test does:
# they all start from an empty folder. Runs inside tests/upgrade/Dockerfile,
# the checkout under test mounted read-only at /src (see tests/run-upgrade.sh).
#
#   1. install the latest release, as a user does: clone, ./install.sh
#   2. use it: start the daemon, make a project and a ticket
#   3. a new release comes out upstream: the commit under test, tagged
#   4. `aiball update`, the way this install was made
#   5. the commands on the PATH answer as the new version, the daemon starts on
#      the old data, its migrations have run, the ticket is still there
#
# What it does NOT cover: a restart by a supervisor (no systemd here: the
# daemon is started by hand), the `--symlink` install, Windows, and an npm
# package installed over another.
set -euo pipefail

SRC=/src
PORT=17777
step() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

git config --global --add safe.directory '*'
git config --global user.email pilot@example.test
git config --global user.name pilot
git config --global advice.detachedHead false

BASE="${AIBALL_UPGRADE_BASE:-$(git -C "$SRC" describe --tags --abbrev=0)}"
HEAD_SHA="$(git -C "$SRC" rev-parse --short HEAD)"
NEW_VERSION=99.0.0

start_daemon() {
    ( cd "$HOME/.local/lib/aiball" && AIBALL_PORT=$PORT nohup npm start >> "$HOME/daemon.log" 2>&1 & )
    for _ in $(seq 1 60); do
        curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/health" > /dev/null && return 0
        sleep 1
    done
    tail -30 "$HOME/daemon.log" >&2
    fail "the daemon did not answer within 60 s"
}
stop_daemon() {
    local pid
    pid="$(cat "$HOME/.local/share/aiball/daemon.pid")"
    kill "$pid"
    for _ in $(seq 1 30); do kill -0 "$pid" 2> /dev/null || return 0; sleep 0.5; done
    fail "the daemon (pid $pid) did not stop"
}
health_version() { curl -sf "http://127.0.0.1:$PORT/api/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'; }

step "1. upstream at $BASE, cloned and installed as a user does"
git clone -q "$SRC" "$HOME/upstream"
git -C "$HOME/upstream" checkout -q -B next HEAD
git -C "$HOME/upstream" checkout -q -B main "$BASE"
git clone -q "$HOME/upstream" "$HOME/aiball"
( cd "$HOME/aiball" && ./install.sh --no-systemd --no-gnome-extension --port $PORT )
OLD_VERSION="$(aiball --version)"
echo "installed: $OLD_VERSION"
for bin in aiball claude-loop aiball-mcp; do
    [ -L "$HOME/.local/bin/$bin" ] || fail "$bin is not linked on the PATH"
done

step "2. the old version in use: a project and a ticket"
start_daemon
echo "daemon: $(health_version)"
# Over the local socket, no token to mint. Filed by the CLI's own agent identity, the
# ticket waits for moderation: that is the state the upgrade must keep.
aiball project init upgraded
aiball ticket new --project upgraded --title "filed before the upgrade" --body "must survive it"
BEFORE="$(aiball ticket list --project upgraded --status pending --json)"
echo "$BEFORE" | grep -q "filed before the upgrade" || fail "the ticket was not filed: $BEFORE"
stop_daemon

step "3. a release comes out upstream: $HEAD_SHA, tagged v$NEW_VERSION"
git -C "$HOME/upstream" checkout -q main
git -C "$HOME/upstream" merge -q --ff-only next
( cd "$HOME/upstream" && npm version "$NEW_VERSION" --no-git-tag-version > /dev/null && git commit -q -am "release $NEW_VERSION (upgrade test)" && git tag "v$NEW_VERSION" )

step "4. aiball update"
aiball update --yes
cat "$HOME/.local/share/aiball/update-status.json" 2> /dev/null || true

step "5. after the upgrade"
for bin in aiball claude-loop; do
    got="$("$bin" --version 2>&1)" || fail "$bin no longer runs from the PATH after the upgrade: $got"
    echo "$bin --version: $got"
    case "$got" in *"$NEW_VERSION"*) ;; *) fail "$bin answers '$got', not $NEW_VERSION" ;; esac
done
# The MCP server has no --version: it answers its first message, or it is broken.
MCP="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"upgrade-test","version":"0"}}}' | timeout 30 aiball-mcp 2> /dev/null | head -1 || true)"
echo "$MCP" | grep -q '"serverInfo"' || fail "aiball-mcp did not answer initialize: ${MCP:0:200}"
echo "aiball-mcp: answers initialize"

start_daemon
NOW="$(health_version)"
echo "daemon: $NOW"
[ "$NOW" = "$NEW_VERSION" ] || fail "the daemon runs $NOW, not $NEW_VERSION"
AFTER="$(aiball ticket list --project upgraded --status pending --json)"
echo "$AFTER" | grep -q "filed before the upgrade" || fail "the ticket filed before the upgrade is gone: $AFTER"
echo "the ticket filed before the upgrade is still there"

# Every migration the new version ships is recorded as applied on the old data.
( cd "$HOME/.local/lib/aiball" && node -e '
    const Database = require("better-sqlite3");
    const journal = require("./drizzle/migrations/meta/_journal.json").entries.length;
    const db = new Database(process.env.HOME + "/.local/share/aiball/aiball.db", { readonly: true });
    const applied = db.prepare("select count(*) as n from __drizzle_migrations").get().n;
    console.log("migrations: " + applied + " applied, " + journal + " shipped");
    if (applied !== journal) process.exit(1);
' ) || fail "the database is not at the new version's schema"
stop_daemon

printf '\nupgrade %s -> %s (%s): passed\n' "$OLD_VERSION" "$NEW_VERSION" "$HEAD_SHA"
