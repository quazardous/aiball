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
import threading
import queue
import time

# #729 phase 2 — websocket-client over UDS for IPC with the timer
# (proxy-events + view-push). Required in LIVE mode only ; `--replay`
# and `--replay-log` short-circuit before any socket use, so they keep
# working without the dep. The live `main()` path checks `_HAS_WEBSOCKET`
# and fails fast with a clear hint if missing.
try:
    import websocket  # type: ignore
    _HAS_WEBSOCKET = True
except ImportError:
    websocket = None  # type: ignore
    _HAS_WEBSOCKET = False


def _state_dir():
    return os.environ.get("CL_STATE_DIR") or ""


def _loop_sock_path():
    """#730 step 1 — single per-loop IPC socket. Timer is the SERVER
    (#729 inversion), proxy + hooks are clients. Today carries only
    view-push frames (`{kind:"view"}`) ; upcoming steps fold proxy-events
    and inject onto the same socket. Transport : ws over UDS via
    `websocket-client` on the Python side. Previously named
    `view-push.sock` (#627)."""
    sd = _state_dir()
    return os.path.join(sd, "loop.sock") if sd else ""




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
    """#839 Slice 1 — local file fallback dropped (no-op). The
    `human-typing` marker is set EXCLUSIVELY via the timer's dispatcher
    (`emit_marker("touch_marker")` → `touchHumanTyping(sd)` on the TS
    side). If the emit fails (timer not reachable), the proxy skips
    silently rather than writing the file locally — single-writer
    discipline (#766 / #844 race fix)."""
    return


# #745 phase B — `touch_user_grace` / `clear_user_grace` Python helpers
# removed. The TS-side dispatcher already accepts the marker events as
# no-ops (forward-compat) ; the AFK SM (typing arms NOT AFK 10m via the
# proxy_events emit_typing path) is now the single source of truth for
# "human present." No marker file write, no in-process bookkeeping.


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

# #862 Slice 4 — `_HUMAN_*` constants retirées. Le BarRenderer côté
# timer (TS) est l'unique writer de `@cl_human` ; le proxy ne peint plus.
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


# #840 Slice A (#766) — module-level cache of the last pushed_view from
# the timer, populated by `_apply_pushed_view`. Read-only consumers (e.g.
# `_afk_mode`) consult it instead of reading the `afk` shadow file.
#
# #840 `4z59jt` (Slice 2) — david "vire tout marker fichier" : on retire
# le fallback fichier. Le cache est hydraté par le timer via WS push
# (cf. `_apply_pushed_view`) dès la connexion établie. Tant que le cache
# est cold (= avant le 1er push), _afk_mode retourne None (= OFF) — même
# sémantique que "fichier absent" pré-migration. Pas de race significative :
# la connexion ws + le 1er push interviennent en quelques ms après spawn,
# et le proxy ne consulte pas l'AFK avant la 1ère décision stdin.
_pushed_view_cache = {"view": None}


def _afk_mode():
    """#619 david `3ezsk5` : AFK is now a 3-state. Returns :
       None              → OFF (cache cold OR mode=off/missing)
       "inf"             → AFK ∞ (held indefinitely)
       ("until", <ts>)   → AFK auto-release at that float timestamp

    #840 `4z59jt` — IPC-only. Le cache `_pushed_view_cache` est hydraté
    par le timer (WS push). Aucun fichier consulté."""
    cached = _pushed_view_cache.get("view")
    if cached is None:
        return None
    mode = cached.get("afkMode")
    expiry = cached.get("afkExpiryMs")
    if mode == "wait_inf":
        return "inf"
    if mode == "wait_10m" and isinstance(expiry, (int, float)) and expiry > 0:
        until = expiry / 1000.0  # ms-since-epoch → seconds (float ts)
        if until <= datetime.datetime.now().timestamp():
            return None
        # #858 — return shape MUST match the legacy file path : ("until",
        # <float-ts>). Pré-fix la branche IPC retournait un datetime,
        # ce qui faisait crasher `mode[1] - now_ts` (float) au prochain
        # tour de la main loop dès qu'AFK 10m était armé.
        return ("until", until)
    # mode == "off" or None → OFF
    return None


def set_afk_until(seconds):
    """#619 : AFK auto-release after `seconds` (10min state in the F9 cycle).

    #839 Slice 1 (#766 path) — emit-only. The proxy NEVER writes the
    `afk` file directly anymore ; the timer's dispatcher is the single
    writer (`armAfkViaService` on receipt of `marker:set_afk_10m`). If
    the emit fails (timer not reachable / cold-boot race), the AFK
    mutation is dropped silently — fail-safe instead of leaking a
    file-write past the timer's boot guard (= #844 root cause)."""
    expiry = datetime.datetime.now() + datetime.timedelta(seconds=seconds)
    expiry_ms = int(expiry.timestamp() * 1000)
    _proxy_events.emit({"event": "marker", "name": "set_afk_10m", "expiry_ms": expiry_ms, "now_ms": int(datetime.datetime.now().timestamp() * 1000)})


def set_afk_infinite():
    """#619 : AFK held indefinitely (∞ state in the F9 cycle).

    #839 Slice 1 — emit-only. See `set_afk_until`."""
    _proxy_events.emit({"event": "marker", "name": "set_afk_inf", "now_ms": int(datetime.datetime.now().timestamp() * 1000)})


def clear_afk():
    """#839 Slice 1 — emit-only. See `set_afk_until`."""
    _proxy_events.emit({"event": "marker", "name": "clear_afk", "now_ms": int(datetime.datetime.now().timestamp() * 1000)})


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
        # NOT AFK ∞ → AFK (#745 phase B : user-grace machinery dropped,
        # AFK SM is the single source of truth ; clear_user_grace call
        # removed alongside the helper definition).
        clear_afk()


def arm_afk_10m():
    """#622 david `jzcgmh` : typing arms/refreshes a NOT AFK 10m hold
    EXCEPT when already in NOT AFK ∞ (only F9 can release that).
    From AFK : arm 10m fresh. From NOT AFK 10m : reset the timer to
    10:00. From NOT AFK ∞ : no-op.

    #633 Slice A : in non-degraded mode this is now driven by the timer
    via the proxy-events back-channel — apply_decision routes the
    arm_afk_10m intent to `_proxy_events.emit_typing()` instead of
    calling this function locally. This function stays the FALLBACK for
    degraded mode (no timer connected) so debug-proxy-tty still works."""
    if _afk_mode() == "inf":
        return
    set_afk_until(600)


# #633 Slice A david `ecmrvn` — back-channel client that emits raw events
# to the timer's shared `loop.sock` (#730 step 2 ; was `proxy-events.sock`
# before the consolidation). Persistent connection, reconnect on failure,
# silent no-op if the timer isn't there (degraded mode — the caller falls
# back to local logic). Single instance lazily created.
#
# #729 phase 2 — transport is ws over UDS via `websocket-client`. The
# legacy payload `{event, kind, now_ms, ...}` is WRAPPED in the shape
# `{kind: "proxyEvent", data: <legacy>}` which the ipc-events server
# unwraps on the JS side. Direction unchanged (proxy = CLIENT).
class _ProxyEventEmitter:
    """#769 Phase 1 — writes on the shared connection owned by the
    `_ViewPushClient`. The view-push thread reads frames (auto-ponging
    server heartbeat pings) and detects close events, so the emitter
    inherits liveness detection without running its own thread. When
    the shared connection is down, `emit` returns False and the caller
    falls back to local logic."""

    def __init__(self):
        self._channel = None  # set by attach()

    def attach(self, channel):
        """Bind to the _ViewPushClient that owns the shared ws."""
        self._channel = channel

    def emit(self, payload):
        """Best-effort fire-and-forget. Returns True if the event was
        handed to the kernel send buffer, False if no timer is reachable
        (caller falls back to local logic)."""
        if not _HAS_WEBSOCKET or self._channel is None:
            return False
        wrapped = _json.dumps({"kind": "proxyEvent", "data": payload})
        return self._channel.send(wrapped)

    def emit_typing(self, now_ms):
        return self.emit({"event": "keystroke", "kind": "typing", "now_ms": now_ms})

    def emit_afk_key(self, now_ms):
        # #633 Slice C — F9 toggle event. State machine TS cycles AFK.
        return self.emit({"event": "keystroke", "kind": "afk_key", "now_ms": now_ms})

    def emit_marker(self, name, now_ms):
        # #633 Slice D — touch/clear marker events (human-typing,
        # user-took-over). TS writes the file ; 1:1 mapping for now.
        return self.emit({"event": "marker", "name": name, "now_ms": now_ms})


_proxy_events = _ProxyEventEmitter()


# #729 phase 2 — loop.sock ws client. Direction inversion validated by
# david (8yg34n, go C) : the timer is now SERVER, the proxy connects in
# as CLIENT. #730 step 3 — the client dispatches on `kind` and now
# also handles `inject` frames (wake phrase bytes to write to the PTY),
# folding the former `inject.sock` raw server onto the same channel.
# Frames arrive in a daemon thread (`websocket-client` is blocking) and
# go into per-kind thread-safe queues. The thread writes a byte to a
# self-pipe to wake up the main `select()` loop, which drains both
# queues and applies each item.
class _ViewPushClient:
    """Background ws client connected to `loop.sock`. Two inbound kinds:
    `view` → queue drained as view dicts (paint bar/AFK) ;
    `inject` → queue drained as raw text fragments (write to master_fd).

    Best-effort reconnect with fixed 1s backoff. A missing timer (boot
    race, timer crashed) is silent — the proxy paints from rules-locales
    until the next push lands, exactly like before the inversion.

    #769 Phase 1 — also acts as the SHARED connection for outbound
    proxy events. The recv loop here auto-pongs server-side heartbeat
    pings; `send(payload)` lets the emitter write on the same socket
    so it benefits from the same liveness detection. When recv breaks,
    we reset `self._ws` and the next `send` returns False — the caller
    falls back to local logic until the reconnect cycle completes."""

    def __init__(self, sock_path, wakeup_w):
        self._sock_path = sock_path
        self._wakeup_w = wakeup_w
        self._view_queue = queue.Queue()
        self._inject_queue = queue.Queue()
        self._thread = None
        self._stopped = False
        self._ws = None
        self._ws_lock = threading.Lock()

    def send(self, payload):
        """#769 Phase 1 — write a frame on the shared connection.
        Returns True on success, False if the connection is down (the
        caller falls back to local logic in degraded mode). The recv
        loop owns the lifecycle; we just lock around the write."""
        with self._ws_lock:
            ws = self._ws
            if ws is None:
                return False
            try:
                ws.send(payload)
                return True
            except Exception:
                # Connection dead — drop it; the recv thread (or the
                # next loop iteration) will reconnect. We don't reset
                # self._ws here to avoid racing the reader.
                return False

    def start(self):
        if not self._sock_path or self._thread is not None:
            return
        if not _HAS_WEBSOCKET:
            return  # degraded mode (replay, missing dep) — no IPC
        self._thread = threading.Thread(
            target=self._run, name="loop-sock-client", daemon=True,
        )
        self._thread.start()

    def _wake_main(self):
        try:
            os.write(self._wakeup_w, b"v")
        except OSError:
            pass

    def _run(self):
        while not self._stopped:
            ws = None
            try:
                if not os.path.exists(self._sock_path):
                    time.sleep(1.0)
                    continue
                unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                unix.connect(self._sock_path)
                ws = websocket.create_connection(
                    "ws://localhost/", socket=unix, timeout=5,
                )
                # #769 — publish the connection so the emitter can write on it.
                with self._ws_lock:
                    self._ws = ws
                while not self._stopped:
                    try:
                        msg = ws.recv()
                    except Exception:
                        break
                    if not msg:
                        break
                    text = msg if isinstance(msg, str) else \
                        msg.decode("utf-8", errors="replace")
                    try:
                        frame = _json.loads(text)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not isinstance(frame, dict):
                        continue
                    kind = frame.get("kind")
                    data = frame.get("data")
                    if kind == "view" and isinstance(data, dict):
                        self._view_queue.put(data)
                        self._wake_main()
                    elif kind == "inject" and isinstance(data, dict):
                        text_val = data.get("text")
                        if isinstance(text_val, str):
                            self._inject_queue.put(text_val)
                            self._wake_main()
                    # Unknown kinds dropped silently — forward-compat.
            except (OSError, Exception):
                pass
            finally:
                # #769 — drop the shared handle BEFORE closing so the
                # emitter sees None instead of a half-closed socket.
                with self._ws_lock:
                    self._ws = None
                if ws is not None:
                    try: ws.close()
                    except Exception: pass
            if self._stopped:
                break
            time.sleep(1.0)  # reconnect backoff

    def drain_views(self):
        """Pop every pending view from the queue, in arrival order.
        Called by the main select loop after a wakeup byte fires."""
        out = []
        while True:
            try:
                out.append(self._view_queue.get_nowait())
            except queue.Empty:
                break
        return out

    def drain_injects(self):
        """Pop every pending inject text fragment, in arrival order.
        Called by the main select loop, which writes each fragment to
        the PTY master_fd."""
        out = []
        while True:
            try:
                out.append(self._inject_queue.get_nowait())
            except queue.Empty:
                break
        return out

    def stop(self):
        self._stopped = True
        # Don't join : the daemon thread might be stuck in ws.recv(),
        # but it's daemonized so process exit will reap it.


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
# #745 phase B — l'appel `clear_user_grace()` ici (héritage #357) est
# obsolete : le marker `user-took-over` ne pilote plus rien côté TS
# (AFK SM = single source of truth). Le boot retombe en `loop` via
# l'absence d'AFK hold sans avoir à nettoyer quoi que ce soit.

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
    # #745 phase B — clear_user_grace removed (user-grace is dead).


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
        in_boot = _in_boot_phase()
        if is_typing_keystroke(data):
            d["typing"] = True
            if not in_boot:
                # #622 david `jzcgmh` : typing arms NOT AFK 10m (or refreshes
                # an existing 10m countdown). In NOT AFK ∞ mode it's a no-op
                # (only F9 can release the indefinite hold).
                # #629 david — under --no-wait the picker-typing window
                # also triggers this branch (in_boot=False from T0). The
                # apply_decision layer filters arm_afk_10m out when the
                # bus says barWord=boot, so picker selection doesn't engage
                # AFK while genuine post-boot typing still does.
                # #745 phase B — `touch_user_grace` dropped from the
                # marker list ; AFK SM = single source of truth.
                d["markers"] += ["arm_afk_10m", "touch_marker"]
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
                # #745 phase B — touch_user_grace dropped (user-grace dead).
                d["markers"] += ["arm_afk_10m"]
                self.afk_active = True
            d["word"] = "rest"
            # #858 — claude-code (auto mode) traite ESC nue (idle OU busy
            # post-turn) comme "exit" → claude quitte → tmux pane meurt →
            # kill-on-exit cascade SIGKILL le timer + tout le loop. On ne
            # forward JAMAIS l'ESC à claude : l'AFK est armée localement,
            # claude ne reçoit rien. Trade-off : pour interrompre claude
            # mid-turn, taper Ctrl-C (pas ESC). Un premier essai phase-
            # gated (forward si "busy") a re-crashé en pratique — soit la
            # phase était transient-busy après un drained-wake, soit
            # claude-code exit aussi sur "esc to interrupt". Garder
            # l'ESC interne entièrement résout les deux cas d'un coup.
            # Debug : log la trace pour vérifier que ce path s'exécute (#858 followup).
            sd_dbg = os.environ.get("CL_STATE_DIR") or ""
            if sd_dbg:
                try:
                    with open(os.path.join(sd_dbg, "esc-debug.log"), "a") as _f:
                        _f.write(f"{datetime.datetime.now().isoformat(timespec='milliseconds')}  lone_esc swallowed  in_boot={in_boot}  data={data.hex()}\n")
                except OSError:
                    pass
            return d
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


# #856 Phase 2 — `_user_grace_remaining` retiré : la fonction lisait
# `user-took-over` (marker retiré dans #745 phase B au profit du seul
# AFK SM). Plus aucun call site Python ; le timer TS ne fait plus
# écrire le marker. Comments orphelins ci-dessus + #619 collapse note
# conservés pour l'historique.


def _boot_grace_remaining():
    """#305 : bootstrap fallback time-based — secondes de boot-grace
    restantes (CL_BOOT_GRACE_SEC depuis le spawn proxy), 0.0 hors-fenêtre
    ou sous --no-wait. Utilisé UNIQUEMENT via `_in_boot_phase()` quand
    aucune push timer n'est arrivée (= cold boot du proxy)."""
    if _NO_WAIT:
        return 0.0
    try:
        grace = float(os.environ.get("CL_BOOT_GRACE_SEC") or "60")
    except ValueError:
        grace = 60.0
    rem = grace - (datetime.datetime.now().timestamp() - _BOOT_TS)
    return rem if rem > 0.0 else 0.0


def _in_boot_phase():
    """Source de vérité du booléen "on est en boot phase" pour le proxy.

    Consulte d'abord le pushed view du timer (= autorité : barWord/`inBootGrace`),
    fallback time-based (`_boot_grace_remaining()`) UNIQUEMENT avant la
    1ère push (cold boot).

    Fix observé david : le proxy gardait sa propre boot-grace 60s
    désynchronisée du sealing IPC. Quand le timer sealed `bootComplete`
    à ~T+50s, le proxy continuait à peindre `_HUMAN_BOOT` (jaune) jusqu'à
    T+60s → bar mismatch : bg busy + word claude-boot."""
    cached = _pushed_view_cache.get("view")
    if cached is None:
        # Cold boot — pas encore de push reçue, on tient avec le timer
        # bootstrap pour ne pas afficher "loop" sur un fond yellow.
        return _boot_grace_remaining() > 0.0
    if cached.get("inBootGrace") is True:
        return True
    if cached.get("barWord") == "boot":
        return True
    return False


# #862 Slice 4 — `_rest_word`, `_paint_word`, `_format_afk_state`,
# `_paint_afk_state`, `paint_human` SUPPRIMÉS. Le BarRenderer côté
# timer (TS) est maintenant l'unique writer de `@cl_human` ET
# `@cl_afk_state`. Le proxy émet uniquement les events (`touch_marker`,
# `set_afk_*`, etc.) qui mutent ipcState ; BarRenderer pickup via
# `onIpcChanged` + safety tick 1s.


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

    # #729 phase 2 — live mode requires `websocket-client` for the IPC
    # with the timer (proxy-events emit + view-push receive). Replay
    # modes short-circuited above don't need it.
    if not _HAS_WEBSOCKET:
        sys.stderr.write(
            "claude-loop: missing Python dep `websocket-client`.\n"
            "  Install with: pip install --user websocket-client    (or your package manager)\n"
            "  (see docs/INSTALL.md)\n"
        )
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

    # #627 + #729 phase 2 + #730 step 3 — single ws client connected to
    # the shared `loop.sock`. Receives view-push frames (timer broadcast)
    # AND inject frames (rebroadcast by the timer on behalf of hooks or
    # the timer's own wakes). Per-kind queues are drained by the main
    # select loop after the self-pipe wakeup byte fires. The bar word
    # + AFK chunk are painted from the view received ; the local rules
    # (_rest_word / _format_afk_state) remain as a bootstrap fallback
    # until the timer pushes its first view.
    view_push_pipe_r, view_push_pipe_w = os.pipe()
    fcntl.fcntl(view_push_pipe_r, fcntl.F_SETFL,
                fcntl.fcntl(view_push_pipe_r, fcntl.F_GETFL) | os.O_NONBLOCK)
    view_push_client = _ViewPushClient(_loop_sock_path(), view_push_pipe_w)
    # #769 Phase 1 — wire the emitter to the shared connection BEFORE
    # starting the client thread, so the first attempted emit (proxy
    # bootstrap order: hooks may emit during init) has a channel to ask.
    _proxy_events.attach(view_push_client)
    view_push_client.start()

    stdin_open = True

    # #862 Slice 4 — `current_word`/`current_afk_chunk` retirés. Le
    # BarRenderer (côté timer TS) est le seul writer de `@cl_human` et
    # `@cl_afk_state`, donc le proxy n'a plus rien à tracker.
    # #360 : la décision frappe→action vit désormais dans le cœur PUR `_Decider`
    # (mirror exact de l'ancienne boucle inline ; bufferisation #345 incluse —
    # la 1re combo d'un afk_key à 2 (ex. 1er ESC de `esc esc`) est gardée jusqu'à
    # la fenêtre afk, puis flushée si le combo échoue). Le Decider porte l'état
    # AFK + le buffer `pending`/deadline + `last_keystroke` (lu plus bas pour le
    # timeout du select). main n'APPLIQUE que les actions via apply_decision() →
    # un seul endroit touche l'I/O ; le cœur reste rejouable/asservable (#381).
    decider = _Decider(_afk, _AFK_COMBOS, _ESC_TAKEOVER, _AFK_WINDOW_MS)

    def cleanup():
        # #862 Slice 4 — `paint_human(False)` retiré. Le BarRenderer côté
        # timer continue à peindre @cl_human depuis ipcState après la mort
        # du proxy (proxy-alive disparu, BarRenderer reste autoritaire).
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
        # #729 phase 2 + #730 step 3 — loop.sock client : stop the daemon
        # thread + close the wakeup pipe. The timer (server) cleans up
        # its own socket on its side.
        view_push_client.stop()
        for fd in (view_push_pipe_r, view_push_pipe_w):
            try:
                os.close(fd)
            except OSError:
                pass

    # #627 — `pushed_view` = the last view received from the timer (or None
    # until the first push lands). When set, the painters use it instead of
    # _rest_word / _format_afk_state. Lets us strip the rule code from the
    # proxy without losing bootstrap paint (rules fallback when None).
    pushed_view = {"value": None}  # dict-wrap so nested fns can mutate

    def _apply_pushed_view(view):
        """#627 — receive a view dict pushed by the timer over loop.sock.
        #862 Slice 4 : le proxy ne peint plus ; il met uniquement à jour
        le cache pour que `_afk_mode` (côté Decider) ait l'autorité IPC."""
        pushed_view["value"] = view
        _pushed_view_cache["view"] = view

    def _drain_loop_sock_queue():
        """#729 phase 2 + #730 step 3 — called when the self-pipe has a
        byte ready. Drains the per-kind queues fed by the daemon thread
        `_ViewPushClient` and applies each : view dicts mutent juste le
        cache via `_apply_pushed_view` (#862 Slice 4 — plus de paint) ;
        inject text fragments are written to the PTY master_fd."""
        try:
            while True:
                os.read(view_push_pipe_r, 4096)
        except (BlockingIOError, OSError):
            pass
        for view in view_push_client.drain_views():
            _apply_pushed_view(view)
        for chunk_str in view_push_client.drain_injects():
            try:
                os.write(master_fd, chunk_str.encode("utf-8"))
            except OSError:
                continue
            # #305 — wake injected = proof the gate is open. Le timer mute
            # ipcState côté TS, BarRenderer (= seul writer) sait quoi peindre.
            _note_wake_injected()
            _emit_log({"event": "inject",
                       "now": datetime.datetime.now().timestamp(),
                       "raw": chunk_str.encode("utf-8"),
                       "forward": chunk_str.encode("utf-8"),
                       "markers": ["note_wake_injected"], "word": "loop"})

    def apply_decision(dec):
        """#360 : exécute les EFFETS d'une Decision (markers afk/présence,
        forward vers claude, peinture du mot) puis log diag. SEUL endroit qui
        touche l'I/O — le `_Decider` qui la produit, lui, reste pur.

        #633 Slices A-E — tous les markers de présence sont maintenant
        routés via le back-channel UDS `proxy-events.sock` vers la state
        machine TS (timer.ts). Le fallback local est conservé pour le
        degraded mode (timer absent — debug-proxy-tty, timer crashed).
        `set_afk` / `clear_afk` legacy ne sont plus dispatché ici (jamais
        émis par le _Decider dans le path normal ; F9 utilise toggle_afk).
        Ils restent disponibles comme fonctions appellables si du code
        externe / un test en a besoin."""
        for m in dec.get("markers", []):
            if m == "cycle_afk" or m == "toggle_afk":
                # #633 Slice C : F9 toggle routed via back-channel ; the
                # TS state machine cycles AFK off → 10m → ∞ → off (last
                # transition also clears user-grace). Fallback to local
                # toggle in degraded mode.
                now_ms = int(datetime.datetime.now().timestamp() * 1000)
                if not _proxy_events.emit_afk_key(now_ms):
                    toggle_afk()
            elif m == "arm_afk_10m":
                # #633 Slice A : delegate to timer via back-channel.
                # Fall back to local on failure (degraded mode).
                now_ms = int(datetime.datetime.now().timestamp() * 1000)
                if not _proxy_events.emit_typing(now_ms):
                    arm_afk_10m()
            elif m == "touch_marker":
                # #633 Slice D : delegate to TS state machine via back-channel.
                # Fallback local on failure (degraded mode).
                now_ms = int(datetime.datetime.now().timestamp() * 1000)
                if not _proxy_events.emit_marker("touch_marker", now_ms):
                    touch_marker()
            elif m == "touch_user_grace" or m == "clear_user_grace":
                # #745 phase B — user-grace machinery dropped TS-side ;
                # the proxy stops emitting these markers (no fallback
                # needed either : the AFK SM events that the Decider
                # already emits cover the same case).
                pass
        if dec.get("forward"):
            os.write(master_fd, dec["forward"])
        # #633 Slice B david `wb69mf` — paint authority migrée à la state
        # machine. apply_decision ne peint plus @cl_human : la touch_marker
        # `human-typing` côté Python + le bus côté timer émettent transition
        # → view pushée → `_apply_pushed_view` peint le bon mot (boot pendant
        # boot grace, stop pendant typing, wait sous AFK, loop sinon).
        # Latence typing → paint stop ≈ 50ms (watch debounce) — invisible.
        # Le hack 0a45bba (override paint _HUMAN_BOOT quand bus dit boot)
        # disparaît : le bus EST l'autorité, plus besoin d'override post-fact.
        # Le fallback bootstrap (pushed_view = None) reste plus bas dans la
        # boucle select pour la fenêtre proxy-start → première view-push.
        _emit_log(dec)

    try:
        while True:
            rfds = [master_fd]
            if stdin_open:
                rfds.append(stdin_fd)
            # #729 phase 2 + #730 step 3 — the self-pipe fed by the
            # daemon `_ViewPushClient` wakes up select() whenever a
            # view or inject frame arrives on loop.sock.
            rfds.append(view_push_pipe_r)
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
            # #862 Slice 4 — pas besoin de timeout court "wait" : le
            # BarRenderer côté timer a son safety tick 1s qui catch le
            # countdown AFK et le TTL typing → loop. Le proxy n'a plus
            # rien à peindre.
            try:
                ready, _, _ = select.select(rfds, [], [], timeout)
            except (InterruptedError, OSError):
                continue  # SIGWINCH etc. interrompent select

            # #862 Slice 4 — bootstrap fallback paint retiré. Le BarRenderer
            # (côté timer) peint depuis ipcState dès son `start()` ; pas
            # besoin de fallback côté proxy.

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
                    _read_err = None
                except OSError as _e:
                    out = b""   # slave fermé = claude a quitté
                    _read_err = repr(_e)
                if not out:
                    # #858 debug — log POURQUOI la main loop sort.
                    _sd_dbg = os.environ.get("CL_STATE_DIR") or ""
                    if _sd_dbg:
                        try:
                            with open(os.path.join(_sd_dbg, "esc-debug.log"), "a") as _f:
                                _ts = datetime.datetime.now().isoformat(timespec="milliseconds")
                                _f.write(f"{_ts}  proxy main-loop break  read_err={_read_err}  master_fd={master_fd} pid={pid}\n")
                        except OSError:
                            pass
                    break
                os.write(sys.stdout.fileno(), out)

            # 3) #729 phase 2 + #730 step 3 — loop.sock self-pipe
            # wakeup. Drains both queues : view frames (paint bar/AFK)
            # and inject frames (write to master_fd + wake markers). The
            # former wake injection path through `inject_srv` (raw bytes
            # on a dedicated `inject.sock`) is gone — wakes now ride the
            # shared loop.sock as `{kind:"inject"}` frames rebroadcast
            # by the timer.
            if view_push_pipe_r in ready:
                _drain_loop_sock_queue()
    finally:
        cleanup()

    # Récupère le code de sortie de claude et le propage.
    try:
        _, status = os.waitpid(pid, 0)
    except OSError as _e:
        # #858 debug — log la sortie claude.
        _sd_dbg = os.environ.get("CL_STATE_DIR") or ""
        if _sd_dbg:
            try:
                with open(os.path.join(_sd_dbg, "esc-debug.log"), "a") as _f:
                    _ts = datetime.datetime.now().isoformat(timespec="milliseconds")
                    _f.write(f"{_ts}  proxy waitpid err  err={repr(_e)}\n")
            except OSError:
                pass
        return 0
    # #858 debug — log claude exit status.
    _sd_dbg = os.environ.get("CL_STATE_DIR") or ""
    if _sd_dbg:
        try:
            with open(os.path.join(_sd_dbg, "esc-debug.log"), "a") as _f:
                _ts = datetime.datetime.now().isoformat(timespec="milliseconds")
                _exited = os.WIFEXITED(status)
                _signaled = os.WIFSIGNALED(status)
                _code = os.WEXITSTATUS(status) if _exited else None
                _sig = os.WTERMSIG(status) if _signaled else None
                _f.write(f"{_ts}  proxy claude exit  exited={_exited} code={_code} signaled={_signaled} sig={_sig} status_raw={status}\n")
        except OSError:
            pass
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 0


if __name__ == "__main__":
    # #858 debug — catch toute exception non-attrapée pour qu'on voie d'où
    # elle vient (un traceback dans le tmux pane est souvent invisible :
    # pane meurt avec le proxy).
    def _excepthook(exc_type, exc_value, exc_tb):
        import traceback as _tb
        sd_dbg = os.environ.get("CL_STATE_DIR") or ""
        if sd_dbg:
            try:
                with open(os.path.join(sd_dbg, "esc-debug.log"), "a") as _f:
                    ts = datetime.datetime.now().isoformat(timespec="milliseconds")
                    _f.write(f"{ts}  proxy UNCAUGHT  type={exc_type.__name__}\n")
                    _tb.print_exception(exc_type, exc_value, exc_tb, file=_f)
                    _f.write("\n")
            except OSError:
                pass
        # Continue avec le hook par défaut pour que stderr garde le traceback.
        sys.__excepthook__(exc_type, exc_value, exc_tb)
    sys.excepthook = _excepthook
    sys.exit(main(sys.argv))
