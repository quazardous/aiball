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

The first implementation (`kernel.ts::detectHumanTyping`) answered it by
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
| **Human keystrokes** | proxy stdin (from tmux) → claude PTY | emit `touch_marker` event over `loop.sock` (if real text), then forward |
| **claude output** | claude PTY master → proxy stdout (to tmux) | forwarded raw |
| **Wake injection** | `loop.sock` inject frame → claude PTY | forwarded, **no human-typing event** |

### Why injection moved off `send-keys`

If the loop kept injecting wake phrases via `tmux send-keys`, those
bytes would arrive on the proxy's **stdin** — indistinguishable from a
human typing. So injection rides a dedicated WebSocket frame on
`loop.sock` (kind `inject`) ; the proxy receives the frame, writes the
bytes straight to claude's PTY, and emits **no** human-typing event.

Result: the **only** thing arriving on the proxy's stdin is the human.
Channel separation is now *physical*, not heuristic.

## The human-typing IPC stamp

On every real keystroke the proxy emits a `touch_marker` event over
`loop.sock`. The timer's state-machine receives it and stamps
`ipc.humanTypingAtMs = Date.now()`. The bar word (`stop` red while
fresh ; `wait`/`loop` otherwise, TTL 5s) and the wake gate read this
in-memory value via `getIpcState().humanTypingAtMs`. There is no
human-typing marker file — the stamp lives only in the timer process.

Only **text** keystrokes count : `is_typing_keystroke` whitelists
printable ASCII plus TAB / ENTER / BACKSPACE (= autocomplete, submit,
correction — all signals of active human presence), and skips ESC
sequences + Ctrl-combos. (The filter heuristic is loosely inspired by
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
- **Unix-only by nature.** Python's `pty` is Unix-only. This Python proxy
  is therefore the Unix implementation only — Windows runs the Rust
  `cl-pty-proxy` (see `PTY-PROXY-WINDOWS.md`).
- **Fail-safe.** If PTY allocation/setup fails, the proxy `exec`s claude
  directly — the live terminal is never bricked.

> **Direction — the Rust proxy is the successor.** The Rust `cl-pty-proxy`
> is a single cross-platform binary: it already runs the Windows path in
> production and also builds and passes CI on Linux (a working Unix entry
> point mirrors this file's behaviour). The intended end state is for it
> to replace this Python proxy on Unix too, so one implementation covers
> both platforms. Until that cutover lands, the loop still launches
> **this** Python proxy on Unix — the Rust Unix path is built and tested
> but not yet wired into the launch flow.

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

### Unified session capture — `CL_CAPTURE=1`

`CL_CAPTURE=1` is the single switch that records a whole session into
`<state_dir>/capture/` so it can be replayed later. It supersedes the
scattered debug logs (`CL_PROXY_LOG`, `CL_PANE_CAPTURE_LOG`,
`CL_BAR_PAINT_LOG`), which keep working as deprecated aliases. Each
writer-process appends its own NDJSON timeline (one file per process keeps
appends atomic), all stamped with the same epoch-seconds `t` so the streams
merge into one timeline:

```
<state_dir>/capture/
  proxy.ndjson     # proxy: human keystroke decisions + synthetic injects (event:"inject")
  panes.ndjson     # timer: one row per distinct pane frame → {t, kind:"pane", file}
  panes/<ms>.txt   # the pane frames themselves (referenced by `file`, not inlined)
```

`CL_PROXY_LOG=<file>` still takes priority over the capture dir for the
proxy stream (explicit legacy path). Enable it on a running loop with
`claude-loop reload <name> --set CL_CAPTURE=1` (the env is patched before the
respawn). The capture is append-only — it's scoped to the session you want
to record, so delete the dir when done.

**Inspecting a capture — `bin/cl-capture`.** A whole capture dir is far too
large to read raw (every keystroke + full-screen pane dumps). `cl-capture`
(zero-dep Python) merges `proxy.ndjson` + `panes.ndjson` by `t` and exposes
context-frugal views:

```bash
cl-capture timeline DIR              # one line per event (panes shown by ref + footer preview)
cl-capture grep DIR 'Compact this conversation' --footer 12   # only matching footer lines + their t
cl-capture diff DIR --consecutive    # each frame's delta vs the previous (collapses near-identical panes)
cl-capture pane DIR @42 --footer 6   # the pane nearest t+42s, last 6 non-empty lines
cl-capture stats DIR                 # counts, duration, markers, words
```

**Replaying a boot from a capture — `bin/cl-replay-boot`.** Re-drives the
captured pane timeline through the *real* boot watchers + `BootMachine` on a
virtual clock and reports whether the recorded boot phase sealed — turning a
recorded session into a deterministic verdict (no tmux, no claude). Exit code
is non-zero when the boot never sealed.

```bash
cl-replay-boot <capture-dir>          # human verdict + module start/end edges
cl-replay-boot <capture-dir> --json   # machine-readable result
# → "NEVER SEALED — stuck on [compact_confirm]" when the confirm prompt
#   lingers in the footer and its module never ends.
```

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

- Linux/Unix only (Windows runs the Rust `cl-pty-proxy`). The Rust proxy
  is the intended cross-platform successor on Unix too — see the Direction
  note above.
- Requires `python3` at runtime on the loop host.
- Only printable-text keystrokes flip the badge; navigation/control keys
  are intentionally ignored.
