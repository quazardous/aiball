# claude-loop PTY proxy

> A tiny pseudo-terminal proxy interposed between tmux and `claude`, so
> claude-loop can tell **a human typing** apart from **claude's output**
> and from **its own wake injection** — live, even while claude is busy
> streaming. Resolves the busy-typing blind spot (#a6wgdg / #efuuau).

---

## Why it exists

claude-loop paints a tmux bar word to show human presence — `loop`
(green, autonomous) / `wait` (yellow, auto-pings frozen during a grace
window) / `stop` (red, a human is typing in the pane, so the loop
yields). To paint `stop` it must answer one question continuously:
**is a human typing right now?** (Full word mapping in
[`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md#3-the-tmux-bar-word--stop--wait--loop).)

The first implementation (`timer.ts::detectHumanTyping`) answered it by
**pane-diffing** — capturing the bottom of the tmux pane every ~1.5 s
and noticing when it changed. That has two hard limits:

1. **Idle only.** While claude streams output, the pane changes
   constantly from claude's own rendering, drowning any human
   keystrokes. So detection was gated to the prompt (idle); typing
   *during* a busy turn was not detected until the next idle tick
   (#a6wgdg — "if I type while claude is busy my input isn't detected
   right away").
2. **Can't separate the loop's own injection.** At idle, a pane change
   is *either* a human typing *or* the loop's own wake `send-keys`. The
   only way to tell them apart was a timestamp heuristic
   (`lastSendAt` / `recentlySentKeys`: "ignore changes within 3 s of our
   own send-keys"). Fragile by construction (#efuuau — "the whole
   problem is distinguishing a human keystroke from a claude-loop
   injection").

tmux exposes no per-keystroke event, and `capture-pane` only ever shows
the **rendered output**, where the echo of human input and claude's
output are already merged. The two streams are only physically distinct
at the **PTY layer** — which is exactly where this proxy sits.

## The idea — interpose a PTY

Normally tmux launches claude directly on the pane's pseudo-terminal:

```
terminal → tmux → PTY(tmux) → claude
```

The proxy inserts itself as the innermost layer of the pane: tmux
launches the proxy, and the proxy launches claude on a **second, nested
PTY** that it owns:

```
terminal → tmux → PTY(tmux) → [pty-proxy] → PTY(claude) → claude
```

At the proxy, the human's keystrokes (arriving on its stdin from tmux)
and claude's output (arriving on the inner PTY master) are **two
distinct file descriptors**. So the proxy can label every byte by
origin — busy or idle — which `capture-pane` could never do.

## The three channels

| Channel | Source → sink | Side effect |
|---|---|---|
| **Human keystrokes** | proxy stdin (from tmux) → claude PTY | touch the `human-typing` marker (if it's real text), then forward |
| **claude output** | claude PTY master → proxy stdout (to tmux) | forwarded raw |
| **Wake injection** | UDS socket `$CL_STATE_DIR/inject.sock` → claude PTY | forwarded, **marker untouched** |

### Why injection moved off `send-keys` (the #efuuau key)

If the loop kept injecting wake phrases via `tmux send-keys`, those
bytes would arrive on the proxy's **stdin** — indistinguishable from a
human typing. So injection is moved to a dedicated **control socket**:
the loop writes the wake phrase to `$CL_STATE_DIR/inject.sock`, the proxy
relays it straight to claude's PTY and does **not** touch the marker.

Result: the **only** thing arriving on the proxy's stdin is the human.
Channel separation is now *physical*, not heuristic — `lastSendAt` /
`recentlySentKeys` become obsolete.

## The human-typing marker

The proxy writes a timestamp to `$CL_STATE_DIR/human-typing` on every
real keystroke. It's read by `state.ts::humanIsTyping` (mtime within
`HUMAN_TYPING_TTL_SEC`, 5 s) and drives the human-presence word in
`setTmuxStatus` (`stop` red while fresh; `wait`/`loop` otherwise).

Only **text** keystrokes flip it: the filter `is_typing_keystroke`
skips ESC / control bytes (`< 0x20`, includes arrows, Ctrl-combos, Tab,
Enter) / DEL, so navigating the pane doesn't paint `stop`. (The filter
heuristic is borrowed from
[`martinambrus/claude_timings_wrapper`](https://github.com/martinambrus/claude_timings_wrapper),
MIT.)

## Implementation

`src/claude-loop/pty-proxy.py`, Python standard library only:

- `pty.fork()` — allocate a PTY and fork; the child gets the slave as
  its controlling terminal and `exec`s claude.
- `select()` loop bridging proxy-stdin ↔ claude-PTY-master ↔ inject
  socket.
- `termios` raw mode on the proxy's stdin (best-effort) so keystrokes
  pass through byte-for-byte.
- `SIGWINCH` → re-read the window size and `TIOCSWINSZ` it onto claude's
  PTY (resize propagation).
- `AF_UNIX` `SOCK_STREAM` listener for wake injection.
- Child exit code is propagated as the proxy's exit code.

### Why Python stdlib

- **No native dependency, no compiler.** node-pty would need a C++
  toolchain (node-gyp); this box has `gcc` but not `g++`, and we don't
  want the first native dep in the project.
- **Unix-only is fine here.** Python's `pty` is Unix-only, but Windows
  support is handled separately (psmux), so this proxy deliberately does
  **not** need to be cross-platform or share its tech.
- **Fail-safe.** If PTY allocation/setup fails, the proxy `exec`s claude
  directly — the live terminal is never bricked.

## How it's wired

- `cli.ts` launches the pane as `exec <pty-proxy> -- claude …` instead of
  `exec claude …` (with a strict fallback to plain claude). Only affects
  **newly started** loops.
- `state.ts::injectWakePhrase` writes to `$CL_STATE_DIR/inject.sock`
  instead of `tmux send-keys`, with a `send-keys` fallback for loops not
  started via the proxy.
- The fragile `lastSendAt` / `recentlySentKeys` send-time heuristics are
  gone — the proxy feeds the marker on real keystrokes, busy included.
  The timer's `detectHumanTyping` pane-diff poll stays as a **degraded
  fallback** for loops not started under the proxy (idle-only, ~1.5s).

> **Status:** shipped and wired. `cli.ts` launches the pane through the
> proxy with a strict fallback to plain `claude` (Unix → `pty-proxy.py`;
> Windows → the Rust ConPTY proxy, see `PTY-PROXY-WINDOWS.md`),
> `injectWakePhrase` writes to `inject.sock`, and `proxyIsAlive` (a
> PID-stamped `proxy-alive` marker) is the ground truth for who paints
> the bar's human segment.

## Diagnostic & replay

The proxy's keystroke→action logic — AFK-combo detection, the
first-combo buffering, presence (`stop`/`wait`/`loop`), ESC-takeover —
lives in a **pure decider** (`_Decider`) decoupled from all I/O: it
takes a keystroke (or idle tick) + a clock and **returns the actions**
(bytes to forward, AFK/user-grace marker ops, bar-word intent); the
live loop is the only thing that executes them. Two surfaces fall out
of that seam:

- **Live logger** — set `CL_PROXY_LOG=<file>` and the running proxy
  appends one **NDJSON** record per event (raw bytes hex, what it
  forwarded, marker ops, the verdict flags `afk_fired` / `typing` /
  `lone_esc` / `buffered_first`). Observation-only; absent ⇒ zero cost.
- **Headless replay** — `pty-proxy.py --replay [file]` drives the *same*
  decider from a timed sequence (no `pty.fork`, no tmux, no claude) and
  prints the NDJSON verdicts (plus reconstructed `afk_active` /
  `word_resolved`). The AFK spec comes from the env exactly as live
  (`CL_AFK_SPEC` / `CL_AFK_WINDOW_MS` / `CL_ESC_TAKEOVER` /
  `CL_USER_GRACE_SEC`).

Sequence format, one event per line:

```
<delay_ms> <token>
```

`delay_ms` advances a virtual clock from the previous event; `token` is
a named key (`esc`, `tab`, …), raw hex (`1b`, `1b1b`), a literal
(`a`, `qq`), or `-` / `tick` for an idle tick (fires the buffered
flush). `#`-comments and blank lines are ignored. Example:

```bash
printf '0 esc\n100 esc\n' | python3 src/claude-loop/pty-proxy.py --replay
# → 1st ESC buffered; 2nd within the window fires the AFK combo (set_afk)
```

This is what makes the detection layer testable outside tmux —
`pty-proxy.test.ts` shells real sequences through `--replay` and
asserts the verdicts (the Python equivalent of `afk-key.test.ts`,
without a TS mirror to drift).

## Limitations

- Linux/Unix only by design (Windows = psmux, separate).
- Requires `python3` at runtime on the loop host.
- Only printable-text keystrokes flip the badge; navigation/control keys
  are intentionally ignored.
