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


def _view_push_sock_path():
    """#627 — UDS the proxy listens on for view-push from the timer.
    Newline-delimited JSON ; timer connects once and holds the
    connection open."""
    sd = _state_dir()
    return os.path.join(sd, "view-push.sock") if sd else ""


def _proxy_alive_path():
    sd = _state_dir()
    return os.path.join(sd, "proxy-alive") if sd else ""


# #629 david `xyss9z` — mirror du logBarPaint TS. Off par défaut, on
# par `CL_BAR_PAINT_LOG=1`. Append à `<state_dir>/bar-paint.log` une
# ligne par paint @cl_human depuis le proxy (_paint_word direct ou
# _apply_pushed_view via le timer).
_BAR_PAINT_LOG_ENABLED = os.environ.get("CL_BAR_PAINT_LOG") == "1"
_BAR_PAINT_LOG_T0 = datetime.datetime.now()


def _log_bar_paint(writer, value):
    if not _BAR_PAINT_LOG_ENABLED:
        return
    sd = _state_dir()
    if not sd:
        return
    try:
        t_ms = int((datetime.datetime.now() - _BAR_PAINT_LOG_T0).total_seconds() * 1000)
        with open(os.path.join(sd, "bar-paint.log"), "a") as f:
            f.write(f"[bar-paint] T+{t_ms}ms {writer} @cl_human={value}\n")
    except OSError:
        pass


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


def split_keystrokes(data: bytes, combos=None):
    """#381 (david s4r9n8) : éclate un read brut en touches INDIVIDUELLES pour
    que le détecteur de COMBO ATOMIQUE (« 1 touche par feed ») voie chaque combo
    ISOLÉ, même si l'OS l'a coalescé avec des octets voisins (key-repeat, ou un
    combo collé à du texte). Ordre : CSI (`\\x1b[…`) / SS3 (`\\x1bO.`) gardés
    ENTIERS (flèches, F-keys) ; un combo CONFIGURÉ qui matche à la position
    courante (plus long d'abord) → unité atomique ; sinon un run d'octets gardé
    jusqu'au prochain ESC OU prochain début de combo (un paste/texte reste un
    seul forward ; un combo collé à du texte est bien détaché ; un ESC nu seul
    devient sa propre unité via le garde j==i). Fast-path : aucun combo → [data].
    """
    if combos is None:
        combos = _AFK_COMBOS
    # Plus long d'abord : un combo long prime sur un préfixe plus court.
    combo_set = sorted({bytes(c) for c in combos if c}, key=len, reverse=True)
    if not combo_set:
        return [data]
    units = []
    i, n = 0, len(data)
    while i < n:
        b = data[i]
        if b == 0x1B and i + 1 < n:
            nxt = data[i + 1]
            if nxt == 0x5B:        # CSI : ESC [ … byte final 0x40–0x7e
                j = i + 2
                while j < n and not (0x40 <= data[j] <= 0x7E):
                    j += 1
                if j < n:
                    j += 1         # inclut le byte final
                units.append(data[i:j])
                i = j
                continue
            if nxt == 0x4F:        # SS3 : ESC O <byte> (F1–F4, etc.)
                j = min(i + 3, n)
                units.append(data[i:j])
                i = j
                continue
        # Un combo CONFIGURÉ matche-t-il à cette position ? → unité atomique.
        m = next((c for c in combo_set if data[i:i + len(c)] == c), None)
        if m is not None:
            units.append(data[i:i + len(m)])
            i += len(m)
            continue
        # Run jusqu'au prochain ESC OU prochain DÉBUT de combo (un combo collé
        # à du texte est ainsi détaché ; un paste/texte reste un seul forward ;
        # un ESC nu seul devient sa propre unité via le garde j==i).
        j = i
        while j < n and data[j] != 0x1B and not any(data[j:j + len(c)] == c for c in combo_set):
            j += 1
        if j == i:
            j = i + 1
        units.append(data[i:j])
        i = j
    return units


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
# loop=vert ; #426 : ask=orange.
_HUMAN_STOP = "#[fg=colour196,bg=colour16]stop"
_HUMAN_WAIT = "#[fg=colour178,bg=colour16]wait"
# #619 david `zm2ehq` : 4ème mot dédié `boot` (jaune) pendant la boot-grace.
# Le bar BG passe aussi en jaune via [boot], mais l'ilot noir de claude-WORD
# le laisse parfaitement lisible — donc le `boot` jaune sur ilot noir signale
# clairement "en cours de lancement", distinct de `wait` (humain qui tient
# activement le loop) et de `loop` (autonome).
_HUMAN_BOOT = "#[fg=colour178,bg=colour16]boot"
# #426 + #619 collapse : le mot `ask` (orange) a été retiré. La fenêtre
# unique user-grace (max user/ask, default 600s) gate auto-wakes ET
# AskUserQuestion, donc plus besoin d'un visuel distinct.
_HUMAN_LOOP = "#[fg=colour40,bg=colour16]loop"
# #302/#345: --no-wait (CL_WAIT=0) skips only the boot-grace; a present human
# (live typing → `stop`, armed user-grace → `wait`) is still reflected, aligned
# with humanPresenceWord (state.ts).
_NO_WAIT = os.environ.get("CL_WAIT") == "0"
# #345: a bare ESC on stdin = human interrupt/takeover → arm the user-grace.
# Config-gated via .aiball.yaml `claude_loop.esc_takeover` (default on);
# CL_ESC_TAKEOVER="0" disables it.
_ESC_TAKEOVER = (os.environ.get("CL_ESC_TAKEOVER") or "1") != "0"

# #381 (david debug-proxy-tty) : trace live sur stderr (fd 2) — pour chaque read
# brut, le découpage en touches + la décision AFK par touche. Gated par env, donc
# AUCUN effet en prod (le flag n'est posé que par `claude-loop debug-proxy-tty`).
_DEBUG_TTY = (os.environ.get("CL_PROXY_DEBUG_TTY") or "") == "1"

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


def _afk_mode():
    """#619 david `3ezsk5` : AFK is now a 3-state. File content :
       absent      → OFF
       "inf"       → AFK ∞ (held indefinitely)
       "<iso-ts>"  → AFK auto-release at that timestamp (or OFF if past)
    Returns None / "inf" / ("until", expiry_ts) — None for both
    "file missing" and "file present but timestamp past"."""
    p = _afk_path()
    if not p or not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            content = f.read().strip()
    except OSError:
        return None
    if content == "inf":
        return "inf"
    if not content:
        # #622 — empty AFK file = corrupt write or pre-#619 legacy marker.
        # Either way it's not a state the cycle can advance from cleanly
        # (the OFF→10m→∞→OFF cycle needs the file to be either absent or
        # carry a parseable expiry/inf). Clear it so the next F9 arms a
        # fresh 10m.
        clear_afk()
        return None
    # Treat as ISO expiry timestamp.
    try:
        until = datetime.datetime.fromisoformat(content).timestamp()
    except ValueError:
        # #622 — unparseable content is corrupt state, clear it. Was
        # previously treated as ∞ which silently held the loop.
        clear_afk()
        return None
    if until <= datetime.datetime.now().timestamp():
        return None  # auto-expired
    return ("until", until)


def set_afk_until(seconds):
    """#619 : AFK auto-release after `seconds` (10min state in the F9 cycle)."""
    p = _afk_path()
    if not p:
        return
    expiry = datetime.datetime.now() + datetime.timedelta(seconds=seconds)
    try:
        with open(p, "w") as f:
            f.write(expiry.isoformat() + "\n")
    except OSError:
        pass


def set_afk_infinite():
    """#619 : AFK held indefinitely (∞ state in the F9 cycle)."""
    p = _afk_path()
    if not p:
        return
    try:
        with open(p, "w") as f:
            f.write("inf\n")
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


def toggle_afk():
    """#622 david `jzcgmh` + `2yqjcg` : F9 cycles 3 states (tristate toggle).
       AFK (file absent)  → NOT AFK 10m (set_afk_until 600s)
       NOT AFK 10m        → NOT AFK ∞ (set_afk_infinite)
       NOT AFK ∞          → AFK (clear file + clear user-grace)
    The transition NOT AFK ∞ → AFK clears user-grace too, so the wake
    gate frees up alongside the visible release."""
    mode = _afk_mode()
    if mode is None:
        # AFK → NOT AFK 10m
        set_afk_until(600)
    elif isinstance(mode, tuple):  # ("until", ts) = NOT AFK 10m
        # NOT AFK 10m → NOT AFK ∞
        set_afk_infinite()
    else:  # mode == "inf" = NOT AFK ∞
        # NOT AFK ∞ → AFK (explicit release of both holds)
        clear_afk()
        clear_user_grace()


def arm_afk_10m():
    """#622 david `jzcgmh` : typing arms/refreshes a NOT AFK 10m hold
    EXCEPT when already in NOT AFK ∞ (only F9 can release that).
    From AFK : arm 10m fresh. From NOT AFK 10m : reset the timer to
    10:00. From NOT AFK ∞ : no-op."""
    if _afk_mode() == "inf":
        return
    set_afk_until(600)


# Legacy cycle_afk alias kept for replay shim compatibility — old NDJSON
# runs still emit `cycle_afk` markers ; we map them to the new toggle
# semantics (the test rewrite happens alongside).
def cycle_afk():
    """Deprecated alias for toggle_afk (#622 jzcgmh refactor)."""
    toggle_afk()


def _cycle_afk_legacy_3state():
    """Pre-#622 cycle: OFF → 10m → ∞ → OFF. Kept dead-code for reference
    in case the 3-state visualisation comes back. Not wired anywhere."""
    mode = _afk_mode()
    if mode is None:
        set_afk_until(600)  # 10 minutes
    elif isinstance(mode, tuple):  # ("until", ts)
        set_afk_infinite()
    else:  # "inf"
        clear_afk()


class _AfkDetector:
    """#381 (david s4r9n8) : détecteur de COMBO ATOMIQUE par frappe (mirror de
    afk-key.ts AfkDetector). PLUS de séquence à 2 touches avec fenêtre : une
    frappe qui matche EXACTEMENT l'un des combos configurés TOGGLE l'afk
    immédiatement. `window_ms` ne survit que comme DEBOUNCE post-fire : un chord
    maintenu key-repeat les mêmes octets (sinon N toggles) → pendant window_ms
    après un fire, toute frappe composée UNIQUEMENT d'octets du combo est avalée
    (un seul toggle net par appui physique). Toute autre frappe clôt le debounce."""

    def __init__(self, combos, window_ms):
        self.combos = [bytes(c) for c in combos if c]
        self.window_ms = window_ms
        self.cooldown_until = 0.0
        self.last_residual = False
        self._combo_bytes = set()
        for c in self.combos:
            self._combo_bytes |= set(c)

    def feed(self, data, now):
        self.last_residual = False
        if not self.combos:
            _log_afk_keystroke(data, now, matched=False, fired=False, reason="no-combos-configured")
            return False
        # Debounce : avale le key-repeat des octets du combo juste déclenché.
        if now < self.cooldown_until:
            if data and all(b in self._combo_bytes for b in data):
                self.last_residual = True
                _log_afk_keystroke(data, now, matched=False, fired=False, reason="debounce-residual")
                return False
            self.cooldown_until = 0.0  # toute autre frappe clôt le debounce
        matched = any(data == c for c in self.combos)
        if matched:
            self.cooldown_until = now + self.window_ms / 1000.0
            _log_afk_keystroke(data, now, matched=True, fired=True, reason="combo-match")
            return True  # TOGGLE
        # Log non-matches too — c'est ce qui permet à david de voir si F9
        # arrive bien jusqu'au détecteur mais avec des bytes != attendus
        # (ex. terminal qui émet une autre séquence pour F9). #601 tappj6.
        _log_afk_keystroke(data, now, matched=False, fired=False, reason="no-combo-match")
        return False


# #601 david `tappj6` : log AFK-key trafic dans <state_dir>/afk.log pour
# diagnostic. Always-on (le volume est trivial : une ligne par keystroke
# de l'utilisateur). Trace : bytes reçus + résultat du matcher + combos
# attendus (écrits une fois au boot). Best-effort — ne casse jamais l'I/O.
def _afk_keylog_path():
    sd = os.environ.get("CL_STATE_DIR") or ""
    return os.path.join(sd, "afk.log") if sd else ""


def _log_afk_keystroke(data, now, matched, fired, reason):
    p = _afk_keylog_path()
    if not p:
        return
    try:
        with open(p, "a") as f:
            ts = datetime.datetime.fromtimestamp(now).isoformat(timespec="milliseconds")
            f.write(
                f"{ts}  raw={data.hex() if data else ''}  "
                f"len={len(data) if data else 0}  "
                f"matched={matched}  fired={fired}  reason={reason}\n"
            )
    except OSError:
        pass


def _log_afk_boot():
    p = _afk_keylog_path()
    if not p:
        return
    try:
        with open(p, "a") as f:
            ts = datetime.datetime.now().isoformat(timespec="milliseconds")
            combos_hex = [c.hex() for c in _AFK_COMBOS]
            f.write(
                f"{ts}  === BOOT ===  pid={os.getpid()}  "
                f"combos={combos_hex}  window_ms={_AFK_WINDOW_MS}  "
                f"esc_takeover={_ESC_TAKEOVER}\n"
            )
    except OSError:
        pass


_afk = _AfkDetector(_AFK_COMBOS, _AFK_WINDOW_MS)
_log_afk_boot()  # #601 tappj6 : trace la config AFK au boot
clear_afk()  # #351: drop any stale afk marker left by a previous run, on boot
# #357: idem pour la présence. Depuis #345 (aafe511), `user-took-over` pilote
# le mot `wait` MÊME sous --no-wait (avant : --no-wait => toujours `loop`).
# Un proxy qui relance dans le même CL_STATE_DIR (claude crash/resume au sein
# d'un loop vivant) héritait du marqueur de la session précédente → la barre
# bootait en `wait` et le timer gelait ses auto-pings. Au boot AUCUN humain
# n'a (encore) pris la main pour CE run ; toute présence est stale → on la
# largue, comme clear_afk. S'il est réellement là, sa 1re frappe/ESC ré-arme.
clear_user_grace()  # #357: pas de présence stale héritée → boot en `loop`, pas `wait`

# #305: début de la fenêtre boot-grace = import du proxy (≈ boot du loop).
# Sans --no-wait, le timer gèle TOUS les auto-pings pendant les
# CL_BOOT_GRACE_SEC premières secondes (laisse l'humain prendre la main au
# lancement) → la barre doit lire `wait`, pas `loop`, tant que la fenêtre tient.
_BOOT_TS = datetime.datetime.now().timestamp()


def _note_wake_injected():
    """#305 (david j8xhrh : « vu que claude-loop balance un wake c'est qu'il
    sait qu'il est en mode loop »). Un wake injecté PROUVE que le gate est
    ouvert : le timer/stop-hook ne pinge QUE hors user-grace ET hors boot-grace
    (cf. tryWake, timer.ts:418/425). La barre n'a donc pas à maintenir un état
    d'attente PARALLÈLE qui peut diverger et latcher `wait` (le bug #305) ; le
    wake fait AUTORITÉ. On largue les deux raisons d'attente — boot-grace
    (neutralisée) + user-grace stale (marqueur retiré) — pour que `_rest_word`
    retombe sur `loop` et n'« annule » pas le repeint au tour suivant. La
    prochaine VRAIE frappe humaine ré-armera la présence (→ stop/wait)."""
    global _BOOT_TS
    _BOOT_TS = 0.0          # boot-grace révolue par décision du wake-decider
    clear_user_grace()     # user-grace stale → la barre ne doit plus lire `wait`


# === #360 : cœur de décision PUR + diag NDJSON + replay (tests hors tmux) ===
#
# david (#360) : « rendre la couche détection PURE et attaquable hors tmux →
# tests unitaires sur des séquences capturées ». L'ancienne logique frappe→
# action vivait inline dans la boucle `select` de main(), mêlée à `os.write`,
# aux fichiers-marqueurs et à tmux — impossible à rejouer/asserter. On l'isole
# ici dans `_Decider` : il NE FAIT RIEN (pas d'I/O), il RETOURNE les actions
# (octets à forwarder, markers afk/user-grace, intention de mot) ; l'appelant
# — main() en live OU `--replay` hors tmux — les applique. Même code testé en
# live et en test → zéro dérive de mirror (cf. _AfkDetector ↔ afk-key.ts).


def _proxy_log_path():
    """Chemin du log diag NDJSON, ou "" si désactivé. Activé via env
    `CL_PROXY_LOG=<fichier>` (append) — observation pure, zéro impact
    comportement quand absent."""
    return os.environ.get("CL_PROXY_LOG") or ""


def _decision_record(dec):
    """Aplati une Decision en dict NDJSON-able (octets → hex). Format partagé
    par le logger live et le mode --replay → mêmes fixtures des deux côtés."""
    raw = dec.get("raw") or b""
    fwd = dec.get("forward") or b""
    buf = dec.get("buffer")
    return {
        "t": round(dec.get("now", 0.0), 6),
        "event": dec.get("event"),
        "raw": raw.hex(),
        "forward": fwd.hex(),
        "buffer": buf.hex() if buf else None,
        "markers": dec.get("markers", []),
        "word": dec.get("word"),
        "afk_fired": dec.get("afk_fired", False),
        "typing": dec.get("typing", False),
        "lone_esc": dec.get("lone_esc", False),
        "buffered_first": dec.get("buffered_first", False),
    }


def _emit_log(dec):
    """Append une Decision au log diag si CL_PROXY_LOG est posé. Best-effort —
    le diag ne doit JAMAIS casser le pont I/O de la session live."""
    p = _proxy_log_path()
    if not p:
        return
    try:
        with open(p, "a") as f:
            f.write(_json.dumps(_decision_record(dec)) + "\n")
    except OSError:
        pass


# Tokens nommés acceptés par --replay (sous-ensemble de afk-key.ts NAMED).
_REPLAY_TOKENS = {
    "esc": b"\x1b", "tab": b"\x09", "enter": b"\x0d", "ret": b"\x0d",
    "space": b"\x20", "bs": b"\x7f", "backspace": b"\x7f",
    "del": b"\x1b\x5b\x33\x7e",
}


def _token_to_bytes(tok):
    """Convertit un token de séquence --replay en octets : nom (`esc`,`tab`…),
    hex (`1b`, `1b1b`), sinon littéral UTF-8 (`a`, `qq`)."""
    t = tok.lower()
    if t in _REPLAY_TOKENS:
        return _REPLAY_TOKENS[t]
    try:
        return bytes.fromhex(tok)
    except ValueError:
        return tok.encode()


class _Decider:
    """Cœur PUR : frappe (ou tick) → actions, sans aucun effet de bord (#360).

    Mirror EXACT des branches de l'ancienne boucle stdin (succès combo AFK /
    bufferisation 1re combo / frappe ordinaire + flush différé). Les effets
    sont décrits, pas exécutés :
      - `forward`  : octets à écrire vers claude MAINTENANT (inclut un pending
                     flushé) ;
      - `buffer`   : octets nouvellement bufferisés (1re combo en attente) ;
      - `markers`  : actions ordonnées parmi set_afk / clear_afk / touch_marker
                     / touch_user_grace / clear_user_grace ;
      - `word`     : intention de mot — "stop" (frappe), "rest" (recalcul
                     wait/loop selon grace) ou None (inchangé). La RÉSOLUTION
                     de "rest" est contextuelle (fichiers en live, grace logique
                     en replay) → le Decider reste pur.
    État porté : le détecteur AFK, le buffer pending + sa deadline, et
    `last_keystroke` (lu par main() pour le timeout du select)."""

    def __init__(self, afk, afk_combos, esc_takeover, window_ms):
        self.afk = afk
        self.afk_combos = afk_combos
        self.esc_takeover = esc_takeover
        self.window_ms = window_ms
        self.last_keystroke = 0.0
        # #381 : état afk LOGIQUE (le proxy est seul à écrire le marqueur après
        # le clear_afk de boot → ce booléen reste en phase avec le fichier). Sert
        # à TOGGLE sur le combo (on↔off) au lieu d'un set systématique.
        self.afk_active = False

    def on_stdin(self, data, now):
        d = {"event": "stdin", "now": now, "raw": data,
             "forward": b"", "buffer": None, "markers": [], "word": None,
             "afk_fired": False, "typing": False, "lone_esc": False,
             "buffered_first": False}

        # (a) Le combo AFK RÉUSSIT → on n'envoie RIEN à claude (ni buffer, ni
        #     cette frappe : pas de rewind `esc esc`, pas d'interruption). #381 :
        #     le combo TOGGLE l'afk (on↔off) au lieu de le poser systématiquement
        #     — sinon `esc esc` ne pouvait que l'ARMER, jamais le lever (david :
        #     « esc esc toggle [on] mais après une seule pression suffit [off] »).
        if self.afk.feed(data, now):
            d["afk_fired"] = True
            # #622 david `2yqjcg` : F9 cycles 3 states (AFK → 10m → ∞ → AFK).
            # `arm_afk_10m` for typing exists in parallel (typing can also
            # land you in 10m / refresh it / no-op in ∞).
            d["markers"] += ["toggle_afk"]
            # Predict post-toggle state for the in-decider register —
            # pre-toggle: None → 10m (active), 10m → ∞ (active), ∞ → AFK
            # (off). Source of truth stays the file (read fresh in
            # apply_decision).
            pre = _afk_mode()
            self.afk_active = (pre is None) or isinstance(pre, tuple)
            d["word"] = "rest"
            return d

        # (a') #381b : ESC RÉSIDUEL avalé pendant le cooldown post-toggle. Sans ça
        #     il retombait en branche (c) lone-esc → clear_afk + forward, ce qui
        #     ANNULAIT le toggle qu'on venait de poser ET interrompait claude. On
        #     n'envoie RIEN à claude et on ne touche pas l'afk (il vient d'être posé).
        if self.afk.last_residual:
            return d

        # (b) Frappe ordinaire → forward IMMÉDIAT. #381 (david s4r9n8) : plus de
        #     buffering de la « 1re combo » (la séquence à 2 touches a disparu) →
        #     l'ESC d'interruption atteint claude SANS le délai de 400ms qu'imposait
        #     l'ancien buffer.
        # #624 david `n5kmsz` + `fdj78d` : pendant la fenêtre boot-grace
        # les keystrokes sont IGNORÉS côté AFK / bar — l'utilisateur
        # peut taper pour choisir une discussion --resume sans armer
        # NOT AFK 10m et sans flicker le bar entre stop/wait. Les
        # bytes restent forwardés à claude.
        in_boot = _boot_grace_remaining() > 0.0
        if is_typing_keystroke(data):
            d["typing"] = True
            if not in_boot:
                # #622 david `jzcgmh` : typing arms NOT AFK 10m (or refreshes
                # an existing 10m countdown). In NOT AFK ∞ mode it's a no-op
                # (only F9 can release the indefinite hold). Stays distinct
                # from `touch_user_grace` for back-compat — both arm the
                # same effective 10-min window but mean different things.
                d["markers"] += ["arm_afk_10m", "touch_marker", "touch_user_grace"]
                # Post-marker: AFK is always active after typing — either
                # we just armed 10m (was OFF or refreshed), or we're in ∞
                # (no-op, was already active).
                self.afk_active = True
                d["word"] = "stop"
            else:
                # In boot-grace : keep the bar as `_HUMAN_BOOT` (no stop
                # red flicker). Don't touch any state markers — boot is
                # for resume-picker typing, not human takeover.
                d["word"] = "rest"
            self.last_keystroke = now
        elif self.esc_takeover and _is_lone_esc(data):
            d["lone_esc"] = True
            if not in_boot:
                # #622 david `jzcgmh` : ESC behaves like typing — arms NOT
                # AFK 10m (or refreshes), no-op in ∞. The "interrupt
                # claude" payload still forwards below ; we just don't
                # release the AFK hold the way the old `clear_afk` did.
                d["markers"] += ["arm_afk_10m", "touch_user_grace"]
                self.afk_active = True
            d["word"] = "rest"
        d["forward"] += data
        return d

    def on_flush(self, now):
        """#381 : plus rien n'est bufferisé (la séquence à 2 a disparu) → le flush
        est un no-op. Conservé pour la parité replay/main."""
        return {"event": "flush", "now": now, "raw": b"",
                "forward": b"", "buffer": None, "markers": [], "word": None}


def _run_replay(args):
    """#360 : rejoue une séquence de frappes HORS tmux/claude à travers le cœur
    de décision PUR (`_Decider`) et émet le verdict NDJSON sur stdout — une
    ligne par event. La spec AFK vient de l'env (CL_AFK_SPEC / CL_AFK_WINDOW_MS
    / CL_ESC_TAKEOVER / CL_USER_GRACE_SEC) exactement comme en live.

    Format d'entrée (fichier en argument, sinon stdin), une ligne par event :
        <delay_ms> <token>
    où delay_ms = écart depuis l'event précédent (horloge virtuelle ms) et
    token = nom (`esc`,`tab`…) | hex (`1b`,`1b1b`) | littéral, ou `-`/`tick`
    pour un tick idle (déclenche le flush du pending). Lignes vides / `#…`
    ignorées.

    Le verdict ajoute `afk_active` et `word_resolved` (wait/loop/stop) reconstruits
    depuis les markers + une horloge de grace LOGIQUE, pour asserter l'état sans
    toucher au filesystem."""
    path = None
    for a in args:
        if not a.startswith("-"):
            path = a
            break
    src = open(path) if path else sys.stdin
    afk = _AfkDetector(_AFK_COMBOS, _AFK_WINDOW_MS)
    decider = _Decider(afk, _AFK_COMBOS, _ESC_TAKEOVER, _AFK_WINDOW_MS)
    try:
        grace = float(os.environ.get("CL_USER_GRACE_SEC") or "60")
    except ValueError:
        grace = 60.0
    clock = 0.0
    afk_active = False
    grace_until = 0.0
    try:
        for line in src:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            try:
                delay = float(parts[0])
            except ValueError:
                continue
            clock += delay / 1000.0
            token = parts[1].strip() if len(parts) > 1 else "-"
            if token in ("-", "tick", "flush"):
                decs = [decider.on_flush(clock)]
            else:
                # #381c : un token octets peut représenter un read COALESCÉ
                # (ex. `1b1b` = deux ESC livrés d'un coup). On le re-sépare en
                # touches individuelles, comme en live (main → split_keystrokes),
                # pour que le replay reflète FIDÈLEMENT le réel : c'est le « truc
                # du réel » (coalescing) que le simulateur idéalisé ignorait.
                decs = [decider.on_stdin(u, clock)
                        for u in split_keystrokes(_token_to_bytes(token))]
            for dec in decs:
                # Reconstruit l'état logique afk/grace depuis les markers émis.
                # #619 : `cycle_afk` (F9) marker remplaçe le binary set/clear ;
                # le replay simule un cycle 2-state (OFF↔ON) pour rester simple
                # — le test couvre la SÉQUENCE des fires, pas le state machine
                # 3-state run-time qui vit dans cycle_afk() (state.ts/proxy).
                for m in dec.get("markers", []):
                    if m == "set_afk":
                        afk_active = True
                    elif m == "clear_afk":
                        afk_active = False
                    elif m == "cycle_afk" or m == "toggle_afk":
                        # #622 jzcgmh: F9 = 2-state toggle AFK ↔ NOT AFK ∞.
                        afk_active = not afk_active
                    elif m == "arm_afk_10m":
                        # #622 jzcgmh: typing arms 10m unless in ∞. In
                        # the simulator we don't distinguish 10m vs ∞,
                        # so we just mark active (was-active stays
                        # active, was-off becomes active).
                        afk_active = True
                    elif m == "touch_user_grace":
                        grace_until = clock + grace
                    elif m == "clear_user_grace":
                        grace_until = 0.0
                rec = _decision_record(dec)
                word = dec.get("word")
                rec["afk_active"] = afk_active
                rec["word_resolved"] = (
                    "stop" if word == "stop"
                    else ("wait" if grace_until > clock else "loop") if word == "rest"
                    else None
                )
                sys.stdout.write(_json.dumps(rec) + "\n")
        sys.stdout.flush()
    finally:
        if path:
            src.close()
    return 0


def _run_replay_log(args):
    """#381c : rejoue une CAPTURE LIVE (NDJSON CL_PROXY_LOG) à travers le cœur
    PUR — le « replay du réel » que david réclamait. Le simulateur idéalisé
    (`--replay`) ne voyait que des tokens propres écrits à la main ; ici on
    re-feed les OCTETS EXACTS lus par `os.read` en live (champ `raw`), aux
    DÉLAIS réels (champ `t`), à travers un Decider neuf. Reproduction fidèle
    du « truc du réel » (coalescing/key-repeat) qui échappait au pur token.

    Entrée : le fichier NDJSON écrit en live quand CL_PROXY_LOG est posé
    (`claude-loop start` le propage si l'env est exporté). On ne rejoue que les
    events `stdin` (frappe humaine) et `flush` (timeout du buffer) ; les `inject`
    (wake) ne sont pas de la frappe humaine → ignorés. Sortie : même verdict
    NDJSON que `--replay` (afk_active / word_resolved reconstruits)."""
    path = None
    for a in args:
        if not a.startswith("-"):
            path = a
            break
    if not path:
        sys.stderr.write("pty-proxy --replay-log: need a capture file path\n")
        return 2
    afk = _AfkDetector(_AFK_COMBOS, _AFK_WINDOW_MS)
    decider = _Decider(afk, _AFK_COMBOS, _ESC_TAKEOVER, _AFK_WINDOW_MS)
    try:
        grace = float(os.environ.get("CL_USER_GRACE_SEC") or "60")
    except ValueError:
        grace = 60.0
    state = {"afk_active": False, "grace_until": 0.0}

    def emit(dec, clock):
        for m in dec.get("markers", []):
            if m == "set_afk":
                state["afk_active"] = True
            elif m == "clear_afk":
                state["afk_active"] = False
            elif m == "cycle_afk" or m == "toggle_afk":
                # #622 jzcgmh: F9 = 2-state toggle AFK ↔ NOT AFK ∞.
                state["afk_active"] = not state["afk_active"]
            elif m == "arm_afk_10m":
                # #622 jzcgmh: typing arms 10m unless in ∞.
                state["afk_active"] = True
            elif m == "touch_user_grace":
                state["grace_until"] = clock + grace
            elif m == "clear_user_grace":
                state["grace_until"] = 0.0
        rec = _decision_record(dec)
        word = dec.get("word")
        rec["afk_active"] = state["afk_active"]
        rec["word_resolved"] = (
            "stop" if word == "stop"
            else ("wait" if state["grace_until"] > clock else "loop") if word == "rest"
            else None
        )
        sys.stdout.write(_json.dumps(rec) + "\n")

    with open(path) as src:
        for line in src:
            line = line.strip()
            if not line:
                continue
            try:
                cap = _json.loads(line)
            except ValueError:
                continue
            event = cap.get("event")
            if event not in ("stdin", "flush"):
                continue  # inject (wake) ≠ frappe humaine
            clock = float(cap.get("t", 0.0))
            if event == "flush":
                emit(decider.on_flush(clock), clock)
            else:
                raw = bytes.fromhex(cap.get("raw") or "")
                # Captures live DÉJÀ découpées par unité (main feed
                # split_keystrokes avant chaque on_stdin) ; on re-split par
                # sécurité au cas où une capture pré-#381c serait rejouée.
                for u in (split_keystrokes(raw) if raw else [b""]):
                    emit(decider.on_stdin(u, clock), clock)
    sys.stdout.flush()
    return 0


def _render_keys(data: bytes) -> str:
    """#381 : rendu LISIBLE d'un buffer d'octets (debug-proxy-tty / faux claude).
    `\\x1b` → `ESC`, contrôles → `^X`, imprimables tels quels, reste en hex."""
    named = {0x1b: "ESC", 0x0d: "CR", 0x0a: "LF", 0x09: "TAB", 0x7f: "DEL",
             0x20: "SPACE", 0x03: "^C", 0x04: "^D"}
    out = []
    for b in data:
        if b in named:
            out.append(named[b])
        elif b < 0x20:
            out.append("^" + chr(b + 0x40))
        elif b < 0x7f:
            out.append(chr(b))
        else:
            out.append("\\x%02x" % b)
    return " ".join(out)


def _run_fake_claude(_args):
    """#381 (david) : faux « claude » derrière le proxy, pour `claude-loop
    debug-proxy-tty`. Ne fait que LOGGER ce que le proxy lui forwarde (= ce que
    le vrai claude recevrait), une ligne par read : nb d'octets + hex + décodage.
    Le combo AFK étant AVALÉ par le proxy, il n'arrive jamais ici — c'est
    justement la preuve visible qu'il a été consommé (et pas envoyé à claude).
    Notre tty est mis en raw (pas d'écho, lecture octet par octet) pour ne pas
    doubler l'affichage ni attendre Entrée. Quitte sur Ctrl-C / Ctrl-D / EOF."""
    # Ctrl-C must be a DATA byte (0x03), not a signal: in raw mode the tty
    # won't raise SIGINT, but there's a startup window before setraw where the
    # cooked slave could. Ignore SIGINT so we always handle 0x03 in the loop.
    try:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (ValueError, OSError):
        pass
    old = None
    try:
        import tty
        old = termios.tcgetattr(0)
        tty.setraw(0)
    except (termios.error, OSError):
        old = None
    os.write(1, b"\r\n  [faux claude] j'affiche ce que le proxy me transmet. Ctrl-C pour quitter.\r\n\r\n")
    try:
        while True:
            try:
                data = os.read(0, 65536)
            except OSError:
                break
            if not data:
                break
            stop = 0x03 in data or 0x04 in data
            os.write(1, ("  claude <- %2dB : %-26s %s\r\n" % (
                len(data), data.hex(" "), _render_keys(data))).encode())
            if stop:
                break
    finally:
        if old is not None:
            try:
                termios.tcsetattr(0, termios.TCSAFLUSH, old)
            except (termios.error, OSError):
                pass
    return 0


def _grace_seconds():
    """#619 collapse : single grace window pour wait/AUQ. Pour back-compat,
    on prend le max de CL_USER_GRACE_SEC et CL_ASK_GRACE_SEC — un projet
    qui set encore les 2 verra la plus longue. Défaut 600s."""
    try:
        u = float(os.environ.get("CL_USER_GRACE_SEC") or "600")
    except ValueError:
        u = 600.0
    try:
        a = float(os.environ.get("CL_ASK_GRACE_SEC") or "600")
    except ValueError:
        a = 600.0
    return max(u, a, 0.0)


def _user_grace_remaining():
    """#302 + #619 collapse : secondes de grace restantes (marqueur
    `user-took-over` < max(CL_USER_GRACE_SEC, CL_ASK_GRACE_SEC), default
    600s), 0.0 hors-grâce. Permet au proxy de peindre `wait` (jaune)
    tant que la fenêtre tient, puis `loop` (vert) une fois expirée."""
    sd = os.environ.get("CL_STATE_DIR") or ""
    if not sd:
        return 0.0
    try:
        mtime = os.stat(os.path.join(sd, "user-took-over")).st_mtime
    except OSError:
        return 0.0
    rem = _grace_seconds() - (datetime.datetime.now().timestamp() - mtime)
    return rem if rem > 0.0 else 0.0


# #619 collapse — _ask_grace_remaining et le bar word `ask` retirés.
# La fenêtre unique `_user_grace_remaining` (max user/ask, default 600s)
# couvre maintenant les deux usages historiques.


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
    """Mot au repos (pas de frappe) : `boot` pendant la boot-grace
    (#619 zm2ehq — mot dédié, jaune sur l'ilot noir), `wait` quand
    l'AFK est armé (mode `inf` ou `until > now`), sinon `loop`.
    #619 david `x4myqb` : user-grace ne peint plus `wait` — elle
    continue de geler les auto-pings côté wake gate (silencieux),
    mais le bar word reflète l'état AFK UNIQUEMENT, sinon une frappe
    récente laisse un `wait` jaune même après F9 clear AFK. La
    décomposition fine AFK (countdown / ∞ / couleur) vit à côté du
    hint AFK:F9 dans le status-right — voir `_format_afk_state`."""
    if _boot_grace_remaining() > 0.0:
        return _HUMAN_BOOT
    if _afk_mode() is not None:
        return _HUMAN_WAIT
    return _HUMAN_LOOP


def _mux_argv():
    # MUX_CMD peut être un binaire ou "tmux -L sock" → on split sur l'espace.
    return (os.environ.get("MUX_CMD") or "tmux").split()


def _paint_word(word, writer="proxy:_paint_word"):
    """Écrit `@cl_human = word` sur la session tmux + force un refresh.

    No-op silencieux si la cible tmux est inconnue ou si tmux échoue — la
    barre ne doit JAMAIS pouvoir casser le pont I/O de la session live."""
    target = os.environ.get("CL_TMUX") or ""
    if not target:
        return
    _log_bar_paint(writer, word)
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


# #619 david `jjfdea` + `33zghr` + `f97nu6` + `a2f2gk` + #622 : the AFK
# chunk in status-right is painted by the proxy. David's mental model
# inversion-clarification: `AFK` means "Away From Keyboard" → loop is
# autonomous (the human IS away). The wait states are the OPPOSITE
# semantic — human is present, holding the loop — so the label reads
# `NOT AFK` there. Strict 3-state, AFK file only :
#
#   OFF / loop          : `AFK:F9`            (label dim ≈ noir — "you're AFK, claude runs")
#   AFK-off 10min       : `9m NOT AFK:F9`     (label + countdown JAUNE — "you're here, 10m hold")
#   AFK-off ∞           : `∞ NOT AFK:F9`      (label + ∞ ROUGE — "you're here, indefinite hold")
#
# The remaining-minutes prefix in 10min mode is computed from the file's
# absolute expiry timestamp every tick (cheap diff repaint) — toggle never
# resets an in-progress countdown ; only OFF→10m freshly arms a new
# expiry, ∞→OFF clears, 10m→∞ replaces with an indefinite hold.
# User-grace lives elsewhere (silently gates auto-pings via the wake
# timer ; no longer paints any segment).
def _format_afk_state():
    key = os.environ.get("CL_AFK_KEY_DISP") or "F9"
    fg_dim = os.environ.get("CL_AFK_LABEL_FG_DIM") or "colour238"
    fg_lit = os.environ.get("CL_AFK_LABEL_FG_LIT") or "colour16"
    mode = _afk_mode()
    if mode == "inf":
        # AFK ∞ hold — human is here, NOT AFK, label rouge.
        return f"#[fg=colour196]∞ NOT AFK:#[fg={fg_lit}]{key}"
    if isinstance(mode, tuple):  # ("until", expiry_ts)
        rem = mode[1] - datetime.datetime.now().timestamp()
        if rem >= 60:
            mins = int(rem / 60) + (0 if rem % 60 == 0 else 1)
            prefix = f"{mins}m"
        else:
            prefix = f"{max(1, int(rem))}s"
        # AFK 10m hold — human is here, NOT AFK, label jaune.
        return f"#[fg=colour178]{prefix} NOT AFK:#[fg={fg_lit}]{key}"
    # OFF — human is away, AFK is "on" by default, label dim.
    return f"#[fg={fg_dim}]AFK:#[fg={fg_lit}]{key}"


def _paint_afk_state():
    """Push `@cl_afk_state` to tmux (no-op if no live target)."""
    target = os.environ.get("CL_TMUX") or ""
    if not target:
        return
    mux = _mux_argv()
    try:
        subprocess.run(
            mux + ["set-option", "-t", target, "@cl_afk_state", _format_afk_state()],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
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
    args = argv[1:]
    # #360 : mode diag HEADLESS — rejoue une séquence de frappes à travers le
    # cœur de décision pur (pas de pty.fork, pas de tmux, pas de claude) et émet
    # le verdict NDJSON. Sert aux tests de la couche détection (#381 esc esc…).
    if args and args[0] == "--replay":
        return _run_replay(args[1:])
    # #381c : rejoue une CAPTURE LIVE (NDJSON CL_PROXY_LOG) — le « replay du
    # réel » (octets exacts d'os.read, délais réels) vs les tokens idéalisés.
    if args and args[0] == "--replay-log":
        return _run_replay_log(args[1:])
    # #381 : faux claude (logger d'octets) — lancé COMME ENFANT du proxy par
    # `claude-loop debug-proxy-tty`. Pas de pty.fork ici : on lit notre tty.
    if args and args[0] == "--fake-claude":
        return _run_fake_claude(args[1:])
    cmd = args
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
    # #629 david `8wgq7f` (Bug 2) — no startup paint. cli.ts a déjà seedé
    # `boot` au moment de la création de la session tmux. Painter ici
    # appellerait `_rest_word()` qui retourne LOOP au démarrage (pas d'AFK,
    # pas de typing) → écrase le seed `boot` → flicker boot→loop→boot le
    # temps que le timer pousse sa première view. On reste silencieux ; le
    # premier `_apply_pushed_view` du timer (dans la seconde qui suit)
    # peint correctement le mot.
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

    # #627 — Socket pour le view-push depuis le timer. Newline-delimited JSON,
    # connection persistante côté timer (auto-reconnect). On peint le bar
    # word + AFK chunk depuis la view reçue ; les rules locales (_rest_word /
    # _format_afk_state) restent en bootstrap fallback tant que le timer
    # n'a pas pushé sa première view.
    view_push_srv = None
    view_push_sock_path = _view_push_sock_path()
    if view_push_sock_path:
        try:
            if os.path.exists(view_push_sock_path):
                os.unlink(view_push_sock_path)
            view_push_srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            view_push_srv.bind(view_push_sock_path)
            view_push_srv.listen(2)
            view_push_srv.setblocking(False)
        except OSError:
            view_push_srv = None  # fallback : rules locales

    inject_conns = []
    # Per-connection JSON line buffers for view-push.
    view_push_conns = []   # list of (sock, recv_buffer:bytearray)
    stdin_open = True

    # #274/#302 état du segment human : on ne repeint QUE sur transition.
    # `current_word` = dernier mot peint (stop/wait/loop). Le select se
    # réveille à l'expiration de la frappe (5 s), de la boot-grace (#305) puis
    # de la user-grace pour enchaîner stop→wait→loop sans round-trip par le TS.
    # #629 david `8wgq7f` — on n'a PAS peint au startup (le seed cli.ts est
    # `boot`), donc init `current_word` à None pour qu'un éventuel premier
    # paint via _apply_pushed_view force l'écriture (None != n'importe quel
    # mot ⇒ branche `word_token != current_word` passe).
    current_word = None
    # #360 : la décision frappe→action vit désormais dans le cœur PUR `_Decider`
    # (mirror exact de l'ancienne boucle inline ; bufferisation #345 incluse —
    # la 1re combo d'un afk_key à 2 (ex. 1er ESC de `esc esc`) est gardée jusqu'à
    # la fenêtre afk, puis flushée si le combo échoue). Le Decider porte l'état
    # AFK + le buffer `pending`/deadline + `last_keystroke` (lu plus bas pour le
    # timeout du select). main n'APPLIQUE que les actions via apply_decision() →
    # un seul endroit touche l'I/O ; le cœur reste rejouable/asservable (#381).
    decider = _Decider(_afk, _AFK_COMBOS, _ESC_TAKEOVER, _AFK_WINDOW_MS)

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
        if view_push_srv is not None:
            try:
                view_push_srv.close()
            except OSError:
                pass
            try:
                os.unlink(view_push_sock_path)
            except OSError:
                pass

    # #627 — `pushed_view` = the last view received from the timer (or None
    # until the first push lands). When set, the painters use it instead of
    # _rest_word / _format_afk_state. Lets us strip the rule code from the
    # proxy without losing bootstrap paint (rules fallback when None).
    pushed_view = {"value": None}  # dict-wrap so nested fns can mutate

    def _apply_pushed_view(view):
        """#627 — paint the bar word + AFK chunk from a view dict received
        over view-push. Schema matches `LoopStateView` from loop-state.ts :
        {barWord:"boot"|"stop"|"wait"|"loop", afkChunk:{label, prefix, color},
         phase:..., wakeAllowed:..., wakeSkipReason:..., inBootGrace:...}.
        We use barWord + afkChunk here ; phase/wake are timer-internal."""
        nonlocal current_word
        pushed_view["value"] = view
        # Bar word: convert "boot"/"stop"/"wait"/"loop" to the right
        # _HUMAN_* token. Skip if the proxy is currently in a typing-stop
        # paint (let it finish its 5s flash naturally).
        word_token = {
            "boot": _HUMAN_BOOT,
            "stop": _HUMAN_STOP,
            "wait": _HUMAN_WAIT,
            "loop": _HUMAN_LOOP,
        }.get(view.get("barWord", ""))
        if word_token is not None and word_token != current_word:
            _paint_word(word_token, writer="proxy:_apply_pushed_view")
            current_word = word_token
        # AFK chunk: convert the {label, prefix, color} dict to the tmux
        # format string the proxy's _format_afk_state used to emit.
        chunk = view.get("afkChunk") or {}
        label = chunk.get("label") or "AFK"
        prefix = chunk.get("prefix")
        color = chunk.get("color") or "dim"
        key = os.environ.get("CL_AFK_KEY_DISP") or "F9"
        fg_dim = os.environ.get("CL_AFK_LABEL_FG_DIM") or "colour238"
        fg_lit = os.environ.get("CL_AFK_LABEL_FG_LIT") or "colour16"
        col_code = {"red": "colour196", "yellow": "colour178", "dim": fg_dim}.get(color, fg_dim)
        if prefix:
            chunk_str = f"#[fg={col_code}]{prefix} {label}:#[fg={fg_lit}]{key}"
        else:
            chunk_str = f"#[fg={col_code}]{label}:#[fg={fg_lit}]{key}"
        target = os.environ.get("CL_TMUX") or ""
        if target:
            mux = _mux_argv()
            try:
                subprocess.run(
                    mux + ["set-option", "-t", target, "@cl_afk_state", chunk_str],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                )
                subprocess.run(
                    mux + ["refresh-client", "-S"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                )
            except OSError:
                pass

    def _process_view_push_recv(conn, buf):
        """#627 — drain a view-push connection. Parses every full
        newline-terminated JSON line, applies each as a view. Leftover
        bytes stay buffered for the next read."""
        try:
            chunk = conn.recv(65536)
        except OSError:
            chunk = b""
        if not chunk:
            return False  # peer closed
        buf.extend(chunk)
        while True:
            nl = buf.find(b"\n")
            if nl < 0:
                break
            line = bytes(buf[:nl])
            del buf[:nl + 1]
            if not line.strip():
                continue
            try:
                view = _json.loads(line.decode("utf-8", errors="replace"))
            except (ValueError, UnicodeDecodeError):
                continue  # malformed — skip
            if isinstance(view, dict):
                _apply_pushed_view(view)
        return True  # still open

    def apply_decision(dec):
        """#360 : exécute les EFFETS d'une Decision (markers afk/présence,
        forward vers claude, peinture du mot) puis log diag. SEUL endroit qui
        touche l'I/O — le `_Decider` qui la produit, lui, reste pur."""
        nonlocal current_word
        for m in dec.get("markers", []):
            if m == "set_afk":
                # #619/#622 : legacy set/clear kept callable for replay
                # shim + future code that wants a hard-set. F9 itself
                # uses toggle_afk now.
                set_afk_infinite()
            elif m == "clear_afk":
                clear_afk()
            elif m == "cycle_afk" or m == "toggle_afk":
                # #622 jzcgmh: F9 path. cycle_afk is the legacy alias.
                toggle_afk()
            elif m == "arm_afk_10m":
                # #622 jzcgmh: typing / ESC path.
                arm_afk_10m()
            elif m == "touch_marker":
                touch_marker()
            elif m == "touch_user_grace":
                touch_user_grace()
            elif m == "clear_user_grace":
                clear_user_grace()
        if dec.get("forward"):
            os.write(master_fd, dec["forward"])
        word = dec.get("word")
        if word == "stop":
            if current_word != _HUMAN_STOP:
                _paint_word(_HUMAN_STOP)
                current_word = _HUMAN_STOP
        elif word == "rest":
            want = _rest_word()
            if want != current_word:
                _paint_word(want)
                current_word = want
        _emit_log(dec)

    try:
        last_afk_state = ""
        while True:
            rfds = [master_fd]
            if stdin_open:
                rfds.append(stdin_fd)
            if inject_srv is not None:
                rfds.append(inject_srv)
            rfds.extend(inject_conns)
            if view_push_srv is not None:
                rfds.append(view_push_srv)
            rfds.extend(c for (c, _buf) in view_push_conns)
            # Timeout = prochain changement de mot : d'abord l'expiration
            # de la frappe (5s → ré-évalue stop→rest), puis la plus proche
            # des fins de boot-grace (#305 → bar word `boot`→`loop`/`wait`)
            # et de l'AFK 10m auto-release (#619 → bar word `wait`→`loop`,
            # AFK chunk jaune→dim). user-grace ne peint plus le bar word
            # (#622 c724a89) donc ne contribue plus au timeout.
            # #619 jjfdea : capper à 5s quand on est en `wait` pour
            # rafraîchir le countdown dans `@cl_afk_state` (status-right).
            now_ts = datetime.datetime.now().timestamp()
            typing_rem = HUMAN_TTL_SEC - (now_ts - decider.last_keystroke)
            if typing_rem > 0.0:
                timeout = typing_rem
            else:
                mode = _afk_mode()
                afk_rem = 0.0
                if isinstance(mode, tuple):  # ("until", expiry_ts)
                    afk_rem = max(0.0, mode[1] - now_ts)
                rems = [r for r in (_boot_grace_remaining(), afk_rem) if r > 0.0]
                timeout = min(rems) if rems else None
            in_wait = current_word == _HUMAN_WAIT
            if in_wait:
                timeout = min(timeout, 5.0) if timeout is not None else 5.0
            try:
                ready, _, _ = select.select(rfds, [], [], timeout)
            except (InterruptedError, OSError):
                continue  # SIGWINCH etc. interrompent select

            # #627 — bootstrap fallback only. Once the timer has pushed
            # its first view (`_apply_pushed_view`), all paints come
            # from there ; the local rules below are only used during
            # the brief window from proxy start to first push receive.
            if pushed_view["value"] is None:
                # 0) Hors-frappe (>HUMAN_TTL_SEC) → mot au repos (#302).
                if (datetime.datetime.now().timestamp() - decider.last_keystroke) >= HUMAN_TTL_SEC:
                    want = _rest_word()
                    if want != current_word:
                        _paint_word(want)
                        current_word = want
                # AFK chunk diff (#619 jjfdea).
                afk_state = _format_afk_state()
                if afk_state != last_afk_state:
                    _paint_afk_state()
                    last_afk_state = afk_state

            # 1) Frappe humaine (tmux → nous → claude).
            if stdin_fd in ready:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    # #360 : toute la logique frappe→action vit dans le cœur PUR
                    # `_Decider` ; main n'applique que le résultat. #381 : un read
                    # peut COALESCER plusieurs touches (key-repeat, combo collé à du
                    # texte) → split_keystrokes les re-sépare AVANT le détecteur
                    # (contrat « 1 touche par feed »), en gardant chaque combo
                    # atomique isolé. Les unités d'un même read partagent le même
                    # `now` → le debounce post-fire les traite comme simultanées.
                    now_stdin = datetime.datetime.now().timestamp()
                    units = split_keystrokes(data)
                    if _DEBUG_TTY:
                        os.write(2, ("\r\n[proxy] read %dB  %s  -> %d touche(s)%s\r\n" % (
                            len(data), data.hex(" "), len(units),
                            "  (1 read -> plusieurs touches : COALESCE)" if len(units) > 1 else "")).encode())
                    for unit in units:
                        dec = decider.on_stdin(unit, now_stdin)
                        apply_decision(dec)
                        if _DEBUG_TTY:
                            os.write(2, ("[proxy]   %-12s fired=%s afk=%-4s fwd=%s\r\n" % (
                                _render_keys(unit),
                                "Y" if dec.get("afk_fired") else "-",
                                "AWAY" if decider.afk_active else "back",
                                (dec.get("forward") or b"").hex() or "-")).encode())
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
                        # #305 (david j8xhrh): un wake injecté = preuve que le
                        # gate est ouvert → la barre suit la décision du wake,
                        # pas son propre latch. On force `loop` et on largue les
                        # raisons d'attente (boot/user-grace) pour que le tour
                        # suivant ne repeigne pas `wait`.
                        _note_wake_injected()
                        if current_word != _HUMAN_LOOP:
                            _paint_word(_HUMAN_LOOP)
                            current_word = _HUMAN_LOOP
                        _emit_log({"event": "inject",
                                   "now": datetime.datetime.now().timestamp(),
                                   "raw": chunk, "forward": chunk,
                                   "markers": ["note_wake_injected"], "word": "loop"})
                    else:
                        inject_conns.remove(conn)
                        try:
                            conn.close()
                        except OSError:
                            pass

            # 5) #627 — view-push : nouvelle connection du timer.
            if view_push_srv is not None and view_push_srv in ready:
                try:
                    vp_conn, _ = view_push_srv.accept()
                    vp_conn.setblocking(False)
                    view_push_conns.append((vp_conn, bytearray()))
                except OSError:
                    pass

            # 6) #627 — drain les view-push connections.
            for entry in list(view_push_conns):
                vp_conn, vp_buf = entry
                if vp_conn in ready:
                    if not _process_view_push_recv(vp_conn, vp_buf):
                        view_push_conns.remove(entry)
                        try:
                            vp_conn.close()
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
