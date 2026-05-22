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
import subprocess


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


def _is_lone_esc(data: bytes) -> bool:
    """#345 : vrai si `data` est une touche ESC « nue » (interruption claude),
    PAS une séquence CSI/SS3 (flèches, F-keys → ESC[ / ESCO). On veut armer la
    reprise humaine sur un ESC d'interruption, pas sur une navigation."""
    if not data or data[0] != 0x1B:
        return False
    if len(data) == 1:
        return True
    return data[1] not in (0x5B, 0x4F)  # 0x5B='[' (CSI), 0x4F='O' (SS3)


def touch_marker():
    p = _marker_path()
    if not p:
        return
    try:
        with open(p, "w") as f:
            f.write(datetime.datetime.now().isoformat() + "\n")
    except OSError:
        pass  # le badge ne s'affichera juste pas — jamais bloquant


def touch_user_grace():
    """#315 : la frappe humaine ARME la fenêtre user-grace (marqueur
    `user-took-over`). Sinon la barre faisait stop → loop directement à
    l'expiration de la frappe (5 s) : le mot `wait` ne dépendait QUE du submit
    (hook UserPromptSubmit), pas de la frappe. Taper = l'humain a pris la main
    (même sans soumettre) → on arme la grâce pour faire stop → wait (≈60 s) →
    loop, et le timer gèle aussi ses auto-pings pendant la fenêtre."""
    sd = os.environ.get("CL_STATE_DIR") or ""
    if not sd:
        return
    try:
        with open(os.path.join(sd, "user-took-over"), "w") as f:
            f.write(datetime.datetime.now().isoformat() + "\n")
    except OSError:
        pass


def clear_user_grace():
    """#351 (david #5pq7tb): drop the presence marker. Used when the AFK combo
    fires — the successful combo is EXCLUDED from keystroke/presence detection,
    so we also remove any user-grace its first keystroke (e.g. the 1st ESC of
    `esc esc`) armed. Result: AFK = away, no lingering 'present'."""
    sd = os.environ.get("CL_STATE_DIR") or ""
    if not sd:
        return
    try:
        os.remove(os.path.join(sd, "user-took-over"))
    except OSError:
        pass


# --- Peinture directe du segment human de la barre tmux (#274) ---
# Le proxy POSSÈDE le segment `@cl_human` quand il est vivant : il le
# repeint INSTANTANÉMENT dès la 1re touche (pas de poll, pas de round-trip
# par le timer TS). setTmuxStatus côté TS référence `#{@cl_human}` dans un
# status-left statique et NE le touche pas tant que le proxy tourne
# (proxy-alive présent) → zéro bagarre. La couleur de fond vient de
# `status-bg` (état idle/busy/boot piloté par le TS), donc on n'écrit que
# le fg du mot. En mode dégradé (pas de proxy), c'est le TS qui peint
# `@cl_human` via le pane-diff — ce code-ci ne tourne tout simplement pas.
HUMAN_TTL_SEC = 5  # doit suivre HUMAN_TYPING_TTL_SEC côté TS

# Mots fg-only (le bg = status-bg). Doivent rester alignés avec
# setTmuxStatus / humanBarWord (state.ts) — #302 : stop=rouge, wait=jaune,
# loop=vert.
_HUMAN_STOP = "#[fg=colour196,bg=colour16]stop"
_HUMAN_WAIT = "#[fg=colour178,bg=colour16]wait"
_HUMAN_LOOP = "#[fg=colour40,bg=colour16]loop"
# #302/#345: --no-wait (CL_WAIT=0) skips only the boot-grace; a present human
# (live typing → `stop`, armed user-grace → `wait`) is still reflected, aligned
# with humanPresenceWord (state.ts).
_NO_WAIT = os.environ.get("CL_WAIT") == "0"
# #345: a bare ESC on stdin = human interrupt/takeover → arm the user-grace.
# Config-gated via .aiball.yaml `claude_loop.esc_takeover` (default on);
# CL_ESC_TAKEOVER="0" disables it.
_ESC_TAKEOVER = (os.environ.get("CL_ESC_TAKEOVER") or "1") != "0"

# #351: AFK detection. CL_AFK_SPEC = JSON list of combos (each a list of byte
# ints, produced by the TS parseAfkKey); CL_AFK_WINDOW_MS = max gap (ms)
# between the two combos of a sequence. On the combo we write the `afk`
# marker (the PreToolUse hook then redirects AskUserQuestion → ticket); any
# OTHER keystroke clears it (the human is back). Mirrors afk-key.ts.
import json as _json
try:
    _AFK_COMBOS = [bytes(c) for c in _json.loads(os.environ.get("CL_AFK_SPEC") or "[]")]
except Exception:
    _AFK_COMBOS = []
try:
    _AFK_WINDOW_MS = int(os.environ.get("CL_AFK_WINDOW_MS") or "400")
except ValueError:
    _AFK_WINDOW_MS = 400


def _afk_path():
    sd = os.environ.get("CL_STATE_DIR") or ""
    return os.path.join(sd, "afk") if sd else ""


def set_afk():
    p = _afk_path()
    if not p:
        return
    try:
        with open(p, "w") as f:
            f.write(datetime.datetime.now().isoformat() + "\n")
    except OSError:
        pass


def clear_afk():
    p = _afk_path()
    if not p:
        return
    try:
        os.remove(p)
    except OSError:
        pass


class _AfkDetector:
    """Per-keystroke exact-match detector (mirror of afk-key.ts AfkDetector).

    Fed ONE keystroke's bytes at a time with an injected `now` (seconds).
    A single combo fires on exact match; a 2-combo sequence fires when the
    2nd combo lands within `window_ms` of the 1st. Any other keystroke breaks
    a pending sequence."""

    def __init__(self, combos, window_ms):
        self.combos = combos
        self.window_ms = window_ms
        self.first_at = None

    def feed(self, data, now):
        if not self.combos:
            return False
        c1 = self.combos[0]
        c2 = self.combos[1] if len(self.combos) > 1 else None
        if c2 is None:
            return data == c1
        if (self.first_at is not None
                and (now - self.first_at) * 1000 <= self.window_ms
                and data == c2):
            self.first_at = None
            return True
        if data == c1:
            self.first_at = now
            return False
        self.first_at = None
        return False


_afk = _AfkDetector(_AFK_COMBOS, _AFK_WINDOW_MS)
clear_afk()  # #351: drop any stale afk marker left by a previous run, on boot

# #305: début de la fenêtre boot-grace = import du proxy (≈ boot du loop).
# Sans --no-wait, le timer gèle TOUS les auto-pings pendant les
# CL_BOOT_GRACE_SEC premières secondes (laisse l'humain prendre la main au
# lancement) → la barre doit lire `wait`, pas `loop`, tant que la fenêtre tient.
_BOOT_TS = datetime.datetime.now().timestamp()


def _user_grace_remaining():
    """#302 : secondes de user-grace restantes (marqueur `user-took-over`
    < CL_USER_GRACE_SEC), 0.0 hors-grâce. Permet au proxy de peindre `wait`
    (jaune) tant que la fenêtre tient, puis `loop` (vert) une fois expirée."""
    sd = os.environ.get("CL_STATE_DIR") or ""
    if not sd:
        return 0.0
    try:
        grace = float(os.environ.get("CL_USER_GRACE_SEC") or "60")
    except ValueError:
        grace = 60.0
    try:
        mtime = os.stat(os.path.join(sd, "user-took-over")).st_mtime
    except OSError:
        return 0.0
    rem = grace - (datetime.datetime.now().timestamp() - mtime)
    return rem if rem > 0.0 else 0.0


def _boot_grace_remaining():
    """#305 : secondes de boot-grace restantes (CL_BOOT_GRACE_SEC depuis le
    démarrage du proxy), 0.0 hors-fenêtre ou sous --no-wait. Symétrique de
    _user_grace_remaining : la barre peint `wait` tant qu'il reste du temps,
    puis `loop` une fois la fenêtre écoulée."""
    if _NO_WAIT:
        return 0.0
    try:
        grace = float(os.environ.get("CL_BOOT_GRACE_SEC") or "60")
    except ValueError:
        grace = 60.0
    rem = grace - (datetime.datetime.now().timestamp() - _BOOT_TS)
    return rem if rem > 0.0 else 0.0


def _rest_word():
    """Mot au repos (pas de frappe) : `wait` pendant la boot-grace (#305, nulle
    sous --no-wait) OU la fenêtre user-grace (#345 : armée même sous --no-wait,
    ex. après un ESC), sinon `loop`."""
    if _boot_grace_remaining() > 0.0 or _user_grace_remaining() > 0.0:
        return _HUMAN_WAIT
    return _HUMAN_LOOP


def _mux_argv():
    # MUX_CMD peut être un binaire ou "tmux -L sock" → on split sur l'espace.
    return (os.environ.get("MUX_CMD") or "tmux").split()


def _paint_word(word):
    """Écrit `@cl_human = word` sur la session tmux + force un refresh.

    No-op silencieux si la cible tmux est inconnue ou si tmux échoue — la
    barre ne doit JAMAIS pouvoir casser le pont I/O de la session live."""
    target = os.environ.get("CL_TMUX") or ""
    if not target:
        return
    mux = _mux_argv()
    try:
        subprocess.run(
            mux + ["set-option", "-t", target, "@cl_human", word],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        # -S = rafraîchit la ligne de statut des clients attachés.
        subprocess.run(
            mux + ["refresh-client", "-S"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
    except OSError:
        pass


def paint_human(typing: bool):
    """Compat (#302) : `stop` si frappe en cours, sinon le mot au repos
    (`wait` pendant la user-grace, sinon `loop`). Appelé au démarrage et au
    cleanup ; les transitions fines sont pilotées dans la boucle via
    `_paint_word` + `current_word`."""
    _paint_word(_HUMAN_STOP if typing else _rest_word())


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
    # On possède désormais le segment human de la barre : on le pose à
    # `loop` au repos (claim d'ownership avant que le TS voie proxy-alive).
    paint_human(False)
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

    # #274/#302 état du segment human : on ne repeint QUE sur transition.
    # `current_word` = dernier mot peint (stop/wait/loop). Le select se
    # réveille à l'expiration de la frappe (5 s), de la boot-grace (#305) puis
    # de la user-grace pour enchaîner stop→wait→loop sans round-trip par le TS.
    # Init aligné sur ce que paint_human(False) vient de peindre (≈ `wait` si
    # on démarre en boot-grace, sinon `loop`) → pas de repeint redondant.
    current_word = _rest_word()
    last_keystroke = 0.0

    def cleanup():
        # Rends la main sur le segment human : `loop` au repos, sinon le mot
        # `stop` resterait figé après la mort du proxy (le TS reprend la main
        # via proxy-alive disparu).
        paint_human(False)
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
            # Timeout = prochain changement de mot : d'abord l'expiration de
            # la frappe (5 s → ré-évalue wait/loop), puis la plus proche des
            # fins de boot-grace (#305) / user-grace (wait→loop). Sinon on
            # bloque (None). (#302/#305)
            now_ts = datetime.datetime.now().timestamp()
            typing_rem = HUMAN_TTL_SEC - (now_ts - last_keystroke)
            if typing_rem > 0.0:
                timeout = typing_rem
            else:
                rems = [r for r in (_boot_grace_remaining(), _user_grace_remaining()) if r > 0.0]
                timeout = min(rems) if rems else None
            try:
                ready, _, _ = select.select(rfds, [], [], timeout)
            except (InterruptedError, OSError):
                continue  # SIGWINCH etc. interrompent select

            # 0) Hors-frappe (>HUMAN_TTL_SEC) → mot au repos (`wait` pendant la
            #    user-grace, sinon `loop`) ; repeint seulement sur transition. (#302)
            if (datetime.datetime.now().timestamp() - last_keystroke) >= HUMAN_TTL_SEC:
                want = _rest_word()
                if want != current_word:
                    _paint_word(want)
                    current_word = want

            # 1) Frappe humaine (tmux → nous → claude).
            if stdin_fd in ready:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    if _afk.feed(data, datetime.datetime.now().timestamp()):
                        # #351 (david #5pq7tb): the SUCCESSFUL afk combo is
                        # EXCLUDED from keystroke/presence detection — it means
                        # "away". Set the marker and DROP any presence its first
                        # keystroke armed; never touch_user_grace for this one.
                        set_afk()
                        clear_user_grace()
                        want = _rest_word()
                        if want != current_word:
                            _paint_word(want)
                            current_word = want
                    elif is_typing_keystroke(data):
                        clear_afk()  # any real keystroke = the human is back
                        touch_marker()
                        last_keystroke = datetime.datetime.now().timestamp()
                        # #315/#345: typing arms the user-grace (prolongs the
                        # presence timeout) so the bar does stop → wait → loop.
                        # Armed even under --no-wait — NO_WAIT only skips the
                        # boot-grace, not yielding to a human who's actually here.
                        touch_user_grace()
                        if current_word != _HUMAN_STOP:
                            _paint_word(_HUMAN_STOP)  # transition →stop, instantané
                            current_word = _HUMAN_STOP
                    elif _ESC_TAKEOVER and _is_lone_esc(data):
                        # #345: a bare ESC = human interrupt / takeover. It's
                        # filtered out of is_typing_keystroke (control byte), so
                        # arm the user-grace explicitly → the loop backs off for
                        # CL_USER_GRACE_SEC and the bar reads `wait`. (The 1st
                        # ESC of an afk sequence lands here; a 2nd ESC completes
                        # the combo above, which then clears this presence.)
                        clear_afk()
                        touch_user_grace()
                        want = _rest_word()
                        if want != current_word:
                            _paint_word(want)
                            current_word = want
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
