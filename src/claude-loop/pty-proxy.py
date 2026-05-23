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
        # #381b (david t9kk9s : « le moteur doit oublier sur succès ET sur échec »).
        # Cooldown post-fire + jeu d'octets du combo : après un toggle on AVALE les
        # ESC résiduels (répétition clavier / tap surnuméraire) pendant window_ms
        # au lieu de les laisser ré-armer le détecteur — voir feed().
        self.cooldown_until = 0.0
        self.last_residual = False
        self._combo_bytes = set()
        for c in combos:
            self._combo_bytes |= set(c)

    def feed(self, data, now):
        self.last_residual = False
        if not self.combos:
            return False
        # #381b : OUBLIER SUR SUCCÈS. L'ambiguïté c1==c2 (esc==esc) faisait qu'un
        # ESC traînant juste après un toggle réussi RÉ-ARMAIT le détecteur ; un
        # esc isolé suivant complétait alors un combo FANTÔME et re-togglait (le
        # « après le 1er esc esc une seule pression suffit » de david). Pendant
        # window_ms après un fire, toute frappe composée UNIQUEMENT d'octets du
        # combo est avalée (oubliée, ne ré-arme pas) ; toute autre frappe clôt le
        # cooldown (l'humain agit pour de bon).
        if now < self.cooldown_until:
            self.first_at = None
            if data and all(b in self._combo_bytes for b in data):
                self.last_residual = True
                return False
            self.cooldown_until = 0.0
        c1 = self.combos[0]
        c2 = self.combos[1] if len(self.combos) > 1 else None
        if c2 is None:
            if data == c1:
                self.cooldown_until = now + self.window_ms / 1000.0
                return True
            return False
        # #381 : combo COALESCÉ en un seul read. Le PTY peut livrer les 2 combos
        # d'un coup (ex. `esc esc` tapé vite → b"\x1b\x1b" en un read) ; sans ça
        # `data` (2 octets) ne matchait NI c1 NI c2 → l'armement était
        # non-déterministe selon le batching (« parfois ça se corrompt »). On
        # reconnaît la concaténation → succès immédiat, atomique.
        if data == c1 + c2:
            self.first_at = None
            self.cooldown_until = now + self.window_ms / 1000.0
            return True
        if (self.first_at is not None
                and (now - self.first_at) * 1000 <= self.window_ms
                and data == c2):
            self.first_at = None
            self.cooldown_until = now + self.window_ms / 1000.0
            return True
        if data == c1:
            self.first_at = now
            return False
        self.first_at = None
        return False


_afk = _AfkDetector(_AFK_COMBOS, _AFK_WINDOW_MS)
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
        self.pending = None
        self.pending_deadline = 0.0
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
            if self.afk_active:           # était away → on REVIENT
                d["markers"] += ["clear_afk", "touch_user_grace"]
                self.afk_active = False
            else:                          # était présent → on PART
                d["markers"] += ["set_afk", "clear_user_grace"]
                self.afk_active = True
            self.pending = None
            self.pending_deadline = 0.0
            d["word"] = "rest"
            return d

        # (a') #381b : ESC RÉSIDUEL avalé pendant le cooldown post-toggle. Sans ça
        #     il retombait en branche (c) lone-esc → clear_afk + forward, ce qui
        #     ANNULAIT le toggle qu'on venait de poser ET interrompait claude. On
        #     n'envoie RIEN à claude et on ne touche pas l'afk (il vient d'être posé).
        if self.afk.last_residual:
            return d

        # (b) 1re combo d'une séquence à 2 → on la BUFFERISE (au lieu de la
        #     forwarder) jusqu'à la fenêtre afk. #381 : on NE touche PAS l'afk
        #     ici — ce 1er octet est AMBIGU (peut compléter le combo → toggle, ou
        #     rester un ESC nu → takeover). Clear prématuré = c'était LUI qui
        #     faisait qu'une seule pression suffisait à lever l'afk. La présence,
        #     elle, est armée tout de suite (l'humain agit) ; un succès au coup
        #     suivant la corrigera (clear_user_grace).
        if (len(self.afk_combos) >= 2 and self.afk.first_at is not None
                and data == self.afk_combos[0]):
            self.pending = data
            self.pending_deadline = now + self.window_ms / 1000.0
            d["buffer"] = data
            d["buffered_first"] = True
            typing = is_typing_keystroke(data)
            d["typing"] = typing
            if typing:
                d["markers"] += ["touch_marker", "touch_user_grace"]
                self.last_keystroke = now
            elif self.esc_takeover and _is_lone_esc(data):
                d["lone_esc"] = True
                d["markers"].append("touch_user_grace")
            d["word"] = "stop" if typing else "rest"
            return d

        # (c) Frappe ordinaire. Si une 1re combo était bufferisée, le combo a
        #     ÉCHOUÉ (cette touche n'est pas la 2e) → flush différé AVANT cette
        #     frappe (ordre préservé), puis traitement normal.
        if self.pending is not None:
            d["forward"] += self.pending
            self.pending = None
            self.pending_deadline = 0.0
        if is_typing_keystroke(data):
            d["typing"] = True
            d["markers"] += ["clear_afk", "touch_marker", "touch_user_grace"]
            self.afk_active = False   # toute frappe texte = l'humain est de retour
            self.last_keystroke = now
            d["word"] = "stop"
        elif self.esc_takeover and _is_lone_esc(data):
            d["lone_esc"] = True
            d["markers"] += ["clear_afk", "touch_user_grace"]
            self.afk_active = False
            d["word"] = "rest"
        d["forward"] += data
        return d

    def on_flush(self, now):
        """Tick idle : flush différé du pending si sa deadline est passée
        (combo échoué par timeout). L'appelant ne l'invoque que lorsqu'aucun
        stdin n'est prêt ce tour (parité avec l'ancienne boucle)."""
        d = {"event": "flush", "now": now, "raw": b"",
             "forward": b"", "buffer": None, "markers": [], "word": None}
        if self.pending is not None and now >= self.pending_deadline:
            d["forward"] = self.pending
            self.pending = None
            self.pending_deadline = 0.0
            # #381b : OUBLIER SUR ÉCHEC. La 1re combo a expiré sans 2e moitié →
            # le combo a échoué : le détecteur oublie son armement (sinon first_at
            # restait latché). David : « le moteur doit oublier [...] sur échec ».
            self.afk.first_at = None
        return d


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
                dec = decider.on_flush(clock)
            else:
                dec = decider.on_stdin(_token_to_bytes(token), clock)
            # Reconstruit l'état logique afk/grace depuis les markers émis.
            for m in dec.get("markers", []):
                if m == "set_afk":
                    afk_active = True
                elif m == "clear_afk":
                    afk_active = False
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
    args = argv[1:]
    # #360 : mode diag HEADLESS — rejoue une séquence de frappes à travers le
    # cœur de décision pur (pas de pty.fork, pas de tmux, pas de claude) et émet
    # le verdict NDJSON. Sert aux tests de la couche détection (#381 esc esc…).
    if args and args[0] == "--replay":
        return _run_replay(args[1:])
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

    def apply_decision(dec):
        """#360 : exécute les EFFETS d'une Decision (markers afk/présence,
        forward vers claude, peinture du mot) puis log diag. SEUL endroit qui
        touche l'I/O — le `_Decider` qui la produit, lui, reste pur."""
        nonlocal current_word
        for m in dec.get("markers", []):
            if m == "set_afk":
                set_afk()
            elif m == "clear_afk":
                clear_afk()
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
            typing_rem = HUMAN_TTL_SEC - (now_ts - decider.last_keystroke)
            if typing_rem > 0.0:
                timeout = typing_rem
            else:
                rems = [r for r in (_boot_grace_remaining(), _user_grace_remaining()) if r > 0.0]
                timeout = min(rems) if rems else None
            # #345: si une 1re combo est bufferisée, on doit se réveiller à sa
            # deadline pour la flusher même si plus aucune frappe n'arrive.
            if decider.pending is not None:
                flush_rem = decider.pending_deadline - now_ts
                if flush_rem < 0.0:
                    flush_rem = 0.0
                timeout = flush_rem if timeout is None else min(timeout, flush_rem)
            try:
                ready, _, _ = select.select(rfds, [], [], timeout)
            except (InterruptedError, OSError):
                continue  # SIGWINCH etc. interrompent select

            # 0) Hors-frappe (>HUMAN_TTL_SEC) → mot au repos (`wait` pendant la
            #    user-grace, sinon `loop`) ; repeint seulement sur transition. (#302)
            if (datetime.datetime.now().timestamp() - decider.last_keystroke) >= HUMAN_TTL_SEC:
                want = _rest_word()
                if want != current_word:
                    _paint_word(want)
                    current_word = want

            # 0.5) #345 (david #xvswug): 1re combo bufferisée dont la fenêtre afk
            #      a expiré SANS 2e combo, et aucun stdin ce tour → combo échoué.
            #      Flush différé vers claude (= la frappe nue, ex. ESC = interruption,
            #      juste retardée de ≤ afk_window). Si du stdin est prêt, on laisse
            #      le handler ci-dessous décider (succès du combo / autre touche).
            if decider.pending is not None and stdin_fd not in ready:
                dec = decider.on_flush(datetime.datetime.now().timestamp())
                if dec["forward"]:
                    apply_decision(dec)

            # 1) Frappe humaine (tmux → nous → claude).
            if stdin_fd in ready:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    # #360 : toute la logique frappe→action (succès combo AFK /
                    # bufferisation 1re combo / frappe ordinaire + flush) est dans
                    # le cœur PUR `_Decider` ; main n'applique que le résultat.
                    apply_decision(decider.on_stdin(data, datetime.datetime.now().timestamp()))
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
