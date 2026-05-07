#!/usr/bin/env bash
# Install aiball into ~/.local (code + binaries + systemd user service).
#
#   ./install.sh                # full install (rsync source → ~/.local/lib/aiball)
#   ./install.sh --symlink      # dev install: symlink ~/.local/lib/aiball → this checkout
#                               # (edits in this repo are picked up immediately)
#   ./install.sh --no-systemd   # skip systemd unit
#   ./install.sh --uninstall    # remove everything we installed
set -euo pipefail

PREFIX_LIB="$HOME/.local/lib/aiball"
PREFIX_BIN="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="aiball.service"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

NO_SYSTEMD=false
UNINSTALL=false
SYMLINK=false

for arg in "$@"; do
    case "$arg" in
        --no-systemd) NO_SYSTEMD=true ;;
        --uninstall)  UNINSTALL=true ;;
        --symlink)    SYMLINK=true ;;
        -h|--help)
            sed -n '1,/^set -e/p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) echo "unknown flag: $arg" >&2; exit 1 ;;
    esac
done

c_green='\033[0;32m'; c_yellow='\033[1;33m'; c_red='\033[0;31m'; c_off='\033[0m'
log()  { printf "${c_green}[+]${c_off} %s\n" "$*"; }
warn() { printf "${c_yellow}[!]${c_off} %s\n" "$*"; }
die()  { printf "${c_red}[x]${c_off} %s\n" "$*" >&2; exit 1; }

uninstall() {
    log "Uninstalling aiball..."
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop  "$SERVICE_NAME" 2>/dev/null || true
        systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    fi
    rm -f "$SYSTEMD_DIR/$SERVICE_NAME"
    rm -f "$PREFIX_BIN/aiball" "$PREFIX_BIN/aiball-mcp"
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

# --- systemd user service -------------------------------------------------

if ! $NO_SYSTEMD && command -v systemctl >/dev/null 2>&1; then
    mkdir -p "$SYSTEMD_DIR"
    cp "$PREFIX_LIB/systemd/$SERVICE_NAME" "$SYSTEMD_DIR/$SERVICE_NAME"
    log "Installed $SYSTEMD_DIR/$SERVICE_NAME"
    systemctl --user daemon-reload
    if systemctl --user enable --now "$SERVICE_NAME" 2>/dev/null; then
        log "Service enabled & started. Status: systemctl --user status $SERVICE_NAME"
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

printf '\n────────────────────────────────────────────────────────────────────\n'
printf "${c_green}aiball installed.${c_off}\n"
if $SYMLINK; then
    printf "${c_yellow}(dev install — code dir is a symlink to %s)${c_off}\n" "$SRC_DIR"
fi
cat <<EOF

Next steps:
  1. Verify the daemon:        aiball status
  2. Open the web UI:          http://127.0.0.1:7777
                               (UI requires the frontend build — see README)
  3. Register the MCP server:  see AGENTS.md or README.md
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
