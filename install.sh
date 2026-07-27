#!/usr/bin/env bash
# Install aiball into ~/.local (code + binaries + systemd user service).
#
#   ./install.sh                       # full install (rsync source → ~/.local/lib/aiball)
#   ./install.sh --symlink             # dev install: symlink ~/.local/lib/aiball → this checkout
#                                      # (edits in this repo are picked up immediately)
#   ./install.sh --port 7878           # override listen port (writes a systemd drop-in)
#   ./install.sh --host 0.0.0.0        # override listen host (default 127.0.0.1)
#   ./install.sh --no-systemd          # skip systemd unit
#   ./install.sh --proxy-url URL       # #394: run this daemon as a proxy node
#                  [--proxy-token TOK]  # relaying to a remote aiball (writes the
#                                      # proxy: block; mint TOK on the remote with
#                                      # `aiball auth issue --node`)
#   ./install.sh --uninstall           # remove everything we installed (data kept)
#   ./install.sh --uninstall --purge   # ALSO delete the data dir (accounts, tickets)
#
# Reentrant: re-running with new --port / --host overwrites only the bind
# settings; existing data ($AIBALL_HOME), tokens and accounts are preserved.
set -euo pipefail

PREFIX_LIB="$HOME/.local/lib/aiball"
PREFIX_BIN="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="aiball.service"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

NO_SYSTEMD=false
UNINSTALL=false
PURGE=false
SYMLINK=false
PORT=""
HOST=""
PROXY_URL=""
PROXY_TOKEN=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-systemd) NO_SYSTEMD=true; shift ;;
        --uninstall)  UNINSTALL=true; shift ;;
        --purge)      PURGE=true; shift ;;
        --symlink)    SYMLINK=true; shift ;;
        # #394: proxy-node mode — relay this daemon to a remote aiball.
        --proxy-url)    PROXY_URL="${2:-}"; shift 2 ;;
        --proxy-url=*)  PROXY_URL="${1#--proxy-url=}"; shift ;;
        --proxy-token)   PROXY_TOKEN="${2:-}"; shift 2 ;;
        --proxy-token=*) PROXY_TOKEN="${1#--proxy-token=}"; shift ;;
        --port)       PORT="${2:-}"; shift 2 ;;
        --port=*)     PORT="${1#--port=}"; shift ;;
        --host)       HOST="${2:-}"; shift 2 ;;
        --host=*)     HOST="${1#--host=}"; shift ;;
        -h|--help)
            sed -n '1,/^set -e/p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

if [[ -n "$PORT" && ! "$PORT" =~ ^[0-9]+$ ]]; then
    echo "--port must be numeric, got: $PORT" >&2; exit 1
fi

c_green='\033[0;32m'; c_yellow='\033[1;33m'; c_red='\033[0;31m'; c_off='\033[0m'
log()  { printf "${c_green}[+]${c_off} %s\n" "$*"; }
warn() { printf "${c_yellow}[!]${c_off} %s\n" "$*"; }
die()  { printf "${c_red}[x]${c_off} %s\n" "$*" >&2; exit 1; }

DROPIN_DIR="$SYSTEMD_DIR/$SERVICE_NAME.d"
DEV_DROPIN="$DROPIN_DIR/dev.conf"
BIND_DROPIN="$DROPIN_DIR/bind.conf"

uninstall() {
    log "Uninstalling aiball..."
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop  "$SERVICE_NAME" 2>/dev/null || true
        systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    fi
    rm -f "$SYSTEMD_DIR/$SERVICE_NAME"
    rm -f "$DEV_DROPIN" "$BIND_DROPIN"
    rmdir "$DROPIN_DIR" 2>/dev/null || true
    rm -f "$PREFIX_BIN/aiball" "$PREFIX_BIN/aiball-mcp" "$PREFIX_BIN/claude-loop" "$PREFIX_BIN/aiball-tailscale"
    if [[ -L "$PREFIX_LIB" ]]; then
        # Symlinked install — drop the link, never touch the source it points to
        rm -f "$PREFIX_LIB"
    else
        rm -rf "$PREFIX_LIB"
    fi
    local data_dir="$HOME/.local/share/aiball"
    if $PURGE; then
        rm -rf "$data_dir"
        warn "Purged data dir $data_dir (accounts, tickets, tokens — gone)."
    else
        warn "Data preserved at $data_dir (accounts, tickets). Re-run with --purge for a clean slate."
    fi
    log "Done."
}

if $UNINSTALL; then uninstall; exit 0; fi

# --- prerequisites ---------------------------------------------------------
# Report ALL missing hard deps at once (fail-fast, not one die per re-run), then
# warn up front about the soft deps whose absence only bites LATER: today a
# missing tmux lets the daemon install cleanly, then `claude-loop` dies with a
# cryptic error. Surface it here instead.

missing=()
for bin in node npm rsync; do
    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
done
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [[ "$NODE_MAJOR" -ge 20 ]] || missing+=("node>=20 (found $(node --version))")
fi
if [[ ${#missing[@]} -gt 0 ]]; then
    die "missing required tool(s): ${missing[*]}. Install them (node via nvm or your package manager), then re-run."
fi

# Soft deps — the daemon installs fine without them, but the loop won't run.
command -v tmux >/dev/null 2>&1 \
    || warn "tmux not found — the daemon is fine, but 'claude-loop' needs tmux to run a session. Install it before looping."
command -v git >/dev/null 2>&1 \
    || warn "git not found — needed for wiring projects and cutting releases (scripts/release.sh)."
if ! command -v cargo >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
    warn "no PTY-proxy runtime — the loop needs cargo (builds the fast Rust proxy) OR python3 (the fallback). Install one before looping."
fi

# --- deploy source ---------------------------------------------------------
# Preserve the existing layout when the user didn't ask for a change:
# re-running with just --port / --host / etc. shouldn't flip a dev symlink
# into a prod copy (or vice versa) silently. Only switch when --symlink is
# explicitly passed.

if [[ -L "$PREFIX_LIB" ]] && ! $SYMLINK; then
    SYMLINK=true
    log "Existing install at $PREFIX_LIB is a symlink — keeping dev layout (run --uninstall first to switch to a prod copy)"
fi

# Live human-typing detection uses the Rust PTY proxy (cl-pty-proxy) — the
# default on Unix since the cutover. Build the release binary best-effort : if
# cargo is absent or the build fails, the loop transparently falls back to the
# Python proxy (pty-proxy.py). Built in the source tree so symlink mode shares
# it and rsync mode ships it.
PROXY_DIR="$SRC_DIR/windows/cl-pty-proxy"
if [[ -f "$PROXY_DIR/Cargo.toml" && ! -x "$PROXY_DIR/target/release/cl-pty-proxy" ]]; then
    if command -v cargo >/dev/null 2>&1; then
        log "Building the Rust PTY proxy in $PROXY_DIR (one-time, ~30s)"
        ( cd "$PROXY_DIR" && cargo build --release --quiet ) \
            || warn "Rust proxy build failed — the loop will use the Python proxy (pty-proxy.py) instead"
    else
        warn "cargo not found — the loop will use the Python proxy (pty-proxy.py); install Rust (https://rustup.rs) then re-run to enable the Rust proxy"
    fi
fi

if $SYMLINK; then
    log "Symlinking $PREFIX_LIB → $SRC_DIR (dev install)"
    if [[ -L "$PREFIX_LIB" ]]; then
        rm -f "$PREFIX_LIB"
    elif [[ -e "$PREFIX_LIB" ]]; then
        warn "$PREFIX_LIB exists as a real directory — replacing with a symlink (data dir is separate)"
        rm -rf "$PREFIX_LIB"
    fi
    mkdir -p "$(dirname "$PREFIX_LIB")"
    ln -sfn "$SRC_DIR" "$PREFIX_LIB"
else
    log "Installing code into $PREFIX_LIB"
    if [[ -L "$PREFIX_LIB" ]]; then
        warn "$PREFIX_LIB is currently a symlink — replacing with a real copy"
        rm -f "$PREFIX_LIB"
    fi
    # The daemon serves the SPA from frontend/dist. In symlink mode we
    # share the source dir's dist (which the dev rebuilds on save); in
    # rsync mode we have to ship the built bundle ourselves. Build it
    # in the source tree if missing so rsync picks it up.
    if [[ -f "$SRC_DIR/frontend/package.json" && ! -f "$SRC_DIR/frontend/dist/index.html" ]]; then
        log "Building frontend bundle in $SRC_DIR/frontend (one-time, ~30s)"
        ( cd "$SRC_DIR/frontend" && npm install --silent && npm run build --silent )
    fi
    mkdir -p "$PREFIX_LIB"
    rsync -a --delete \
        --exclude=node_modules --exclude=.git \
        --exclude='*.log' --exclude='.env' --exclude='var' \
        --exclude='frontend/node_modules' \
        --exclude='windows/cl-pty-proxy/target/debug' \
        "$SRC_DIR/" "$PREFIX_LIB/"
fi

# --- install deps ----------------------------------------------------------

log "Installing npm dependencies (this can take ~30s)"
( cd "$PREFIX_LIB" && npm install --silent )
# Note: tsx is a real dependency now (the entrypoints register it in-process),
# so a production install no longer depends on dev dependencies being present.

# --- symlink binaries ------------------------------------------------------

mkdir -p "$PREFIX_BIN"
ln -sf "$PREFIX_LIB/bin/aiball"           "$PREFIX_BIN/aiball"
ln -sf "$PREFIX_LIB/bin/aiball-mcp"       "$PREFIX_BIN/aiball-mcp"
ln -sf "$PREFIX_LIB/bin/claude-loop"      "$PREFIX_BIN/claude-loop"
# #380: tailscale is no longer a user command — it's an internal provider
# managed by the daemon (`aiball providers` / autostart). No symlink.
log "Symlinked $PREFIX_BIN/aiball, aiball-mcp, claude-loop"

# --- systemd user service -------------------------------------------------

if ! $NO_SYSTEMD && command -v systemctl >/dev/null 2>&1; then
    mkdir -p "$SYSTEMD_DIR"
    cp "$PREFIX_LIB/systemd/$SERVICE_NAME" "$SYSTEMD_DIR/$SERVICE_NAME"
    log "Installed $SYSTEMD_DIR/$SERVICE_NAME"

    # Dev install: drop a watch-mode override so edits in src/ auto-reload the daemon
    if $SYMLINK; then
        mkdir -p "$DROPIN_DIR"
        cat > "$DEV_DROPIN" <<'CONF'
# Auto-generated by install.sh --symlink.
# Switches the daemon to tsx watch mode so edits in src/ auto-reload.
# Removed automatically by a non-symlink install or by --uninstall.
[Service]
ExecStart=
ExecStart=/usr/bin/env npx --no-install tsx watch %h/.local/lib/aiball/src/daemon.ts
CONF
        log "Installed dev drop-in: $DEV_DROPIN (tsx watch)"
    elif [[ -f "$DEV_DROPIN" ]]; then
        rm -f "$DEV_DROPIN"
        log "Removed previous dev drop-in (production install — daemon stays static)"
    fi

    # Bind drop-in: overrides AIBALL_HOST/PORT when --host/--port were
    # passed. Idempotent across re-installs — preserves whatever was
    # previously chosen if no flag is given this run.
    if [[ -n "$HOST" || -n "$PORT" ]]; then
        mkdir -p "$DROPIN_DIR"
        {
            echo "# Auto-generated by install.sh --host/--port. Edit via re-run."
            echo "[Service]"
            [[ -n "$HOST" ]] && echo "Environment=AIBALL_HOST=$HOST"
            [[ -n "$PORT" ]] && echo "Environment=AIBALL_PORT=$PORT"
        } > "$BIND_DROPIN"
        log "Wrote bind drop-in: $BIND_DROPIN ($([[ -n "$HOST" ]] && echo "host=$HOST ")$([[ -n "$PORT" ]] && echo "port=$PORT"))"
    fi

    systemctl --user daemon-reload
    if systemctl --user enable "$SERVICE_NAME" 2>/dev/null; then
        systemctl --user restart "$SERVICE_NAME" || true
        log "Service enabled & (re)started. Status: systemctl --user status $SERVICE_NAME"
    else
        warn "Could not enable systemd unit (running outside a user session?). Start manually:"
        warn "    systemctl --user enable --now $SERVICE_NAME"
    fi
else
    warn "Skipping systemd. Start daemon manually with:  cd $PREFIX_LIB && npm start"
fi

# --- PATH check ------------------------------------------------------------

if ! command -v aiball >/dev/null 2>&1; then
    warn "$PREFIX_BIN is not in PATH. Add to your shell rc:"
    warn '    export PATH="$HOME/.local/bin:$PATH"'
fi

# --- Auth bootstrap (#B.94) ------------------------------------------------
# Reentrant: if humans are already configured, we don't reinit. Otherwise
# mint an install token via `aiball auth init` and print the setup URL.
# Independent of the data dir (init never destroys anything).

AIBALL_DATA_DIR="$HOME/.local/share/aiball"
EFFECTIVE_HOST="${HOST:-127.0.0.1}"
EFFECTIVE_PORT="${PORT:-7777}"
EFFECTIVE_URL="http://$EFFECTIVE_HOST:$EFFECTIVE_PORT"
if [[ -n "$PROXY_URL" ]]; then
    # #394: proxy-node mode. This daemon is a transparent relay to a REMOTE
    # aiball — it has NO local DB, so we skip `auth init` (auth lives on the
    # remote). Write the proxy: block and restart so it boots as a relay.
    if command -v aiball >/dev/null 2>&1; then
        if aiball proxy init --url "$PROXY_URL" ${PROXY_TOKEN:+--token "$PROXY_TOKEN"}; then
            if ! $NO_SYSTEMD && command -v systemctl >/dev/null 2>&1; then
                systemctl --user restart "$SERVICE_NAME" 2>/dev/null || true
            fi
            log "proxy-node mode: this daemon relays to $PROXY_URL"
            [[ -z "$PROXY_TOKEN" ]] && warn "no --proxy-token — mint one on the remote ('aiball auth issue --node') then 'aiball proxy init --token <tok>'"
        else
            warn "proxy init failed — check the URL / config"
        fi
    fi
elif command -v aiball >/dev/null 2>&1; then
    # Wait briefly for the daemon to be reachable so the migration that
    # creates `tokens` / `consumers` has run before we query the DB via
    # the CLI (which talks to SQLite directly).
    for _ in 1 2 3 4 5; do
        curl -sS --max-time 1 "$EFFECTIVE_URL/api/health" >/dev/null 2>&1 && break || sleep 1
    done
    if aiball auth init --host "$EFFECTIVE_HOST" --port "$EFFECTIVE_PORT" 2>/dev/null; then
        :
    else
        # Already initialized — surface a hint.
        log "auth already initialized (use 'aiball auth reinit' to mint a fresh setup token)"
    fi
fi

printf '\n────────────────────────────────────────────────────────────────────\n'
printf "${c_green}aiball installed.${c_off}\n"
if $SYMLINK; then
    printf "${c_yellow}(dev install — code dir is a symlink to %s)${c_off}\n" "$SRC_DIR"
fi
cat <<EOF

Next steps:
  1. Verify the daemon:        aiball status
  2. First-time setup:         open the URL printed above (or rerun
                               'aiball auth init' to get a fresh one)
  3. Issue CLI/MCP token:      aiball auth issue --consumer <login> --label cli
                               then save it to $AIBALL_DATA_DIR/cli-env as
                               'export AIBALL_TOKEN=<token>'
  4. Register the MCP server:  see MCP-CLIENT.md or README.md
  5. Run via claude-loop:      'claude-loop start' wraps Claude Code in tmux
                               and CLI-injects all hooks per session — no
                               persistent .claude/settings.json wiring needed.
EOF
if $SYMLINK; then
    printf "  4. Iterate on backend:       edit src/, then 'systemctl --user restart %s'\n" "$SERVICE_NAME"
fi
cat <<EOF

Data dir:    ~/.local/share/aiball
Code dir:    $PREFIX_LIB$($SYMLINK && printf "  (→ %s)" "$SRC_DIR")
Service:     systemctl --user status $SERVICE_NAME
Uninstall:   $SRC_DIR/install.sh --uninstall   (add --purge to also wipe data)
────────────────────────────────────────────────────────────────────
EOF
