#!/usr/bin/env python3
"""
claude-loop PTY proxy (#269, suite de #264 #a6wgdg / #efuuau).

Intercalé entre tmux et claude :

    terminal → tmux → PTY(tmux) → [ce proxy] → PTY(claude) → claude

But : distinguer la frappe HUMAINE de la sortie de claude ET de notre
propre injection wake — busy inclus —, ce que le pane-diff ne pouvait
pas faire (il ne tourne qu'à idle, et confond frappe humaine vs sortie
pendant que claude streame).

Comment :
- Notre stdin (fd 0, ce que tmux nous forwarde) = la frappe HUMAINE.
  À chaque octet « vrai texte » (filtre is_typing_keystroke) on touche
  le marqueur `human-typing` (lu par setTmuxStatus → badge `stop` rouge),
  puis on forwarde au PTY de claude. Marche que claude soit idle ou busy.
- La sortie de claude (master du PTY) → notre stdout, brut.
- L'injection wake n'arrive PLUS par send-keys (qui passerait par notre
  stdin = indistinguable d'un humain) mais par un socket de contrôle UDS
  (`$CL_STATE_DIR/inject.sock`) : on écrit ces octets au PTY de claude
  SANS toucher le marqueur. Séparation physique des canaux → plus
  d'heuristique de timestamp (lastSendAt/recentlySentKeys obsolètes).

Choix Python stdlib (#269, david) : Windows est géré séparément (psmux),
donc pas besoin de cross-plateforme ici → zéro dép, zéro compilation.

Fail-safe : si l'init PTY échoue, on exec claude EN DIRECT (os.execvp)
pour ne JAMAIS casser le terminal de la session live.
"""

import os
import sys
import pty
import select
import signal
import struct
import socket
import termios
import fcntl
import datetime


def _state_dir():
    return os.environ.get("CL_STATE_DIR") or ""


def _marker_path():
    sd = _state_dir()
    return os.path.join(sd, "human-typing") if sd else ""


def _inject_sock_path():
    sd = _state_dir()
    return os.path.join(sd, "inject.sock") if sd else ""


def _proxy_alive_path():
    sd = _state_dir()
    return os.path.join(sd, "proxy-alive") if sd else ""


def is_typing_keystroke(data: bytes) -> bool:
    """Vrai si `data` ressemble à de la frappe humaine de TEXTE.

    On ignore les séquences de navigation/contrôle pour ne pas peindre
    `stop` sur un simple Ctrl/flèche/Tab. Heuristique inspirée de
    martinambrus/claude_timings_wrapper (MIT) : escape, contrôles <32,
    DEL. (#269)
    """
    if not data:
        return False
    b0 = data[0]
    if b0 == 0x1B:        # ESC / début de séquence CSI (flèches, F-keys…)
        return False
    if b0 < 0x20:         # autres contrôles (Ctrl-x, Tab=0x09, Enter=0x0d…)
        return False
    if b0 == 0x7F:        # DEL / backspace
        return False
    return True


def touch_marker():
    p = _marker_path()
    if not p:
        return
    try:
        with open(p, "w") as f:
            f.write(datetime.datetime.now().isoformat() + "\n")
    except OSError:
        pass  # le badge ne s'affichera juste pas — jamais bloquant


def drop_proxy_alive():
    """Marqueur de présence (#269 tcn5ej) déposé dès que le fork PTY a
    réussi → existence = GROUND TRUTH « le pane tourne sous le proxy ».
    La décision de lancement côté TS peut mentir (le fail-safe os.execvp
    ci-dessous se substitue à claude sans proxy si le PTY échoue), seul ce
    fichier prouve que le pont est réellement en place. setTmuxStatus le lit
    pour peindre le glyphe proxy ; on l'efface au cleanup."""
    p = _proxy_alive_path()
    if not p:
        return
    try:
        with open(p, "w") as f:
            f.write(str(os.getpid()) + "\n")
    except OSError:
        pass  # le glyphe ne s'affichera juste pas — jamais bloquant


def get_winsize(fd: int) -> bytes:
    """TIOCGWINSZ sur `fd`, ou une taille par défaut si indispo."""
    try:
        return fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\x00" * 8)
    except OSError:
        return struct.pack("HHHH", 24, 80, 0, 0)


def set_winsize(fd: int, winsize: bytes):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


def main(argv):
    cmd = argv[1:]
    # `--` séparateur optionnel : `pty-proxy.py -- claude …`
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        sys.stderr.write("pty-proxy: no command to run\n")
        return 2

    # Fork avec un PTY neuf : le child reçoit le slave comme tty de
    # contrôle (stdin/out/err), on garde le master côté parent.
    try:
        pid, master_fd = pty.fork()
    except OSError:
        # Fail-safe : impossible d'allouer un PTY → on devient claude
        # directement, le terminal reste fonctionnel.
        os.execvp(cmd[0], cmd)
        return 127  # unreachable

    if pid == 0:
        # --- child : c'est claude ---
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            sys.stderr.write("pty-proxy: exec %s failed: %s\n" % (cmd[0], e))
            os._exit(127)

    # --- parent : le pont ---
    # Le fork a réussi → on FRONTE réellement claude : dépose le marqueur
    # proxy-alive avant tout le reste (le setup socket/termios qui suit peut
    # échouer, mais le pont, lui, est en place).
    drop_proxy_alive()
    # Propage la taille de fenêtre courante au PTY de claude.
    set_winsize(master_fd, get_winsize(sys.stdout.fileno()))

    # Notre stdin (venant de tmux) en raw, pour que la frappe passe
    # octet par octet sans édition de ligne. Best-effort (peut ne pas
    # être un tty en test).
    stdin_fd = sys.stdin.fileno()
    old_termios = None
    try:
        old_termios = termios.tcgetattr(stdin_fd)
        import tty
        tty.setraw(stdin_fd)
    except (termios.error, OSError):
        old_termios = None

    # SIGWINCH → reporter la nouvelle taille sur le PTY de claude.
    def on_winch(_signo, _frame):
        set_winsize(master_fd, get_winsize(sys.stdout.fileno()))
    try:
        signal.signal(signal.SIGWINCH, on_winch)
    except (ValueError, OSError):
        pass

    # Socket de contrôle pour l'injection wake (remplace send-keys).
    inject_srv = None
    sock_path = _inject_sock_path()
    if sock_path:
        try:
            if os.path.exists(sock_path):
                os.unlink(sock_path)
            inject_srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            inject_srv.bind(sock_path)
            inject_srv.listen(8)
            inject_srv.setblocking(False)
        except OSError:
            inject_srv = None  # injection retombera sur send-keys côté TS

    inject_conns = []
    stdin_open = True

    def cleanup():
        if old_termios is not None:
            try:
                termios.tcsetattr(stdin_fd, termios.TCSAFLUSH, old_termios)
            except (termios.error, OSError):
                pass
        pap = _proxy_alive_path()
        if pap:
            try:
                os.unlink(pap)
            except OSError:
                pass
        if inject_srv is not None:
            try:
                inject_srv.close()
            except OSError:
                pass
            try:
                os.unlink(sock_path)
            except OSError:
                pass

    try:
        while True:
            rfds = [master_fd]
            if stdin_open:
                rfds.append(stdin_fd)
            if inject_srv is not None:
                rfds.append(inject_srv)
            rfds.extend(inject_conns)
            try:
                ready, _, _ = select.select(rfds, [], [])
            except (InterruptedError, OSError):
                continue  # SIGWINCH etc. interrompent select

            # 1) Frappe humaine (tmux → nous → claude).
            if stdin_fd in ready:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    if is_typing_keystroke(data):
                        touch_marker()
                    os.write(master_fd, data)
                else:
                    # EOF stdin : on arrête de le poller (claude tourne
                    # encore — on garde le pont sortie + injection vivant).
                    stdin_open = False

            # 2) Sortie de claude (claude → nous → tmux).
            if master_fd in ready:
                try:
                    out = os.read(master_fd, 65536)
                except OSError:
                    out = b""   # slave fermé = claude a quitté
                if not out:
                    break
                os.write(sys.stdout.fileno(), out)

            # 3) Nouvelle connexion d'injection.
            if inject_srv is not None and inject_srv in ready:
                try:
                    conn, _ = inject_srv.accept()
                    conn.setblocking(False)
                    inject_conns.append(conn)
                except OSError:
                    pass

            # 4) Octets injectés (wake) → claude, SANS toucher le marqueur.
            for conn in list(inject_conns):
                if conn in ready:
                    try:
                        chunk = conn.recv(65536)
                    except OSError:
                        chunk = b""
                    if chunk:
                        os.write(master_fd, chunk)
                    else:
                        inject_conns.remove(conn)
                        try:
                            conn.close()
                        except OSError:
                            pass
    finally:
        cleanup()

    # Récupère le code de sortie de claude et le propage.
    try:
        _, status = os.waitpid(pid, 0)
    except OSError:
        return 0
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
