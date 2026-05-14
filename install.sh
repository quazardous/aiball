#!/usr/bin/env bash
# Install aiball into ~/.local (code + binaries + systemd user service).
#
#   ./install.sh                       # full install (rsync source → ~/.local/lib/aiball)
#   ./install.sh --symlink             # dev install: symlink ~/.local/lib/aiball → this checkout
#                                      # (edits in this repo are picked up immediately)
#   ./install.sh --port 7878           # override listen port (writes a systemd drop-in)
#   ./install.sh --host 0.0.0.0        # override listen host (default 127.0.0.1)
#   ./install.sh --no-systemd          # skip systemd unit
#   ./install.sh --no-components       # skip the `components` CLI symlink
#                                      # (bundled sibling — see #B.96. Will move
#                                      # to its own repo + install path later.)
#   ./install.sh --uninstall           # remove everything we installed
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
SYMLINK=false
PORT=""
HOST=""
# TODO(#B.96): when @quazardous/components moves out of this repo, drop
# the bundled install and have its own install.sh / npm package. For
# now we ship it together with --no-components as the opt-out.
WITH_COMPONENTS=true

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-systemd)    NO_SYSTEMD=true; shift ;;
        --uninstall)     UNINSTALL=true; shift ;;
        --symlink)       SYMLINK=true; shift ;;
        --port)          PORT="${2:-}"; shift 2 ;;
        --port=*)        PORT="${1#--port=}"; shift ;;
        --host)          HOST="${2:-}"; shift 2 ;;
        --host=*)        HOST="${1#--host=}"; shift ;;
        --no-components) WITH_COMPONENTS=false; shift ;;
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
    rm -f "$PREFIX_BIN/aiball" "$PREFIX_BIN/aiball-mcp" "$PREFIX_BIN/components"
    if [[ -L "$PREFIX_LIB" ]]; then
        # Symlinked install — drop the link, never touch the source it points to
        rm -f "$PREFIX_LIB"
    else
        rm -rf "$PREFIX_LIB"
    fi
    warn "Data preserved at \$AIBALL_HOME (~/.local/share/aiball). Remove manually if you want a clean slate."
    log "Done."
}

if $UNINSTALL; then uninstall; exit 0; fi

# --- prerequisites ---------------------------------------------------------

command -v node >/dev/null 2>&1 || die "node is required (>=20). Install via nvm or your package manager."
command -v npm  >/dev/null 2>&1 || die "npm is required."
command -v rsync >/dev/null 2>&1 || die "rsync is required."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "node >=20 required, found $(node --version)"

# --- deploy source ---------------------------------------------------------

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
    mkdir -p "$PREFIX_LIB"
    rsync -a --delete \
        --exclude=node_modules --exclude=dist --exclude=.git \
        --exclude='*.log' --exclude='.env' --exclude='var' \
        --exclude='frontend/node_modules' --exclude='frontend/dist' \
        "$SRC_DIR/" "$PREFIX_LIB/"
fi

# --- install deps ----------------------------------------------------------

log "Installing npm dependencies (this can take ~30s)"
( cd "$PREFIX_LIB" && npm install --silent )
# Note: tsx is in devDependencies. We need it at runtime, so install everything.

# --- symlink binaries ------------------------------------------------------

mkdir -p "$PREFIX_BIN"
ln -sf "$PREFIX_LIB/bin/aiball"     "$PREFIX_BIN/aiball"
ln -sf "$PREFIX_LIB/bin/aiball-mcp" "$PREFIX_BIN/aiball-mcp"
log "Symlinked $PREFIX_BIN/aiball and $PREFIX_BIN/aiball-mcp"

# `components` is a sibling tool, bundled here until #B.96 carves it
# out into its own repo. --no-components skips just the symlink; the
# code stays in the install tree so a future re-enable is a no-op.
if $WITH_COMPONENTS; then
    ln -sf "$PREFIX_LIB/bin/components" "$PREFIX_BIN/components"
    log "Symlinked $PREFIX_BIN/components (pass --no-components to skip)"
else
    rm -f "$PREFIX_BIN/components"
    log "Skipped $PREFIX_BIN/components (--no-components)"
fi

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
    warn "Skipping systemd. Start daemon manually with:  aiball-daemon  (or:  cd $PREFIX_LIB && npm start)"
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
if command -v aiball >/dev/null 2>&1; then
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
EOF
if $SYMLINK; then
    printf "  4. Iterate on backend:       edit src/, then 'systemctl --user restart %s'\n" "$SERVICE_NAME"
fi
cat <<EOF

Data dir:    ~/.local/share/aiball
Code dir:    $PREFIX_LIB$($SYMLINK && printf "  (→ %s)" "$SRC_DIR")
Service:     systemctl --user status $SERVICE_NAME
Uninstall:   $SRC_DIR/install.sh --uninstall
────────────────────────────────────────────────────────────────────
EOF
