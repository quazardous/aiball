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
[`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md#3-the-tmux-bar-glyphs).)

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

The proxy is `cl-pty-proxy`, one Rust binary for Unix and Windows, built from
`windows/cl-pty-proxy/` with `cargo build --release` (the installer does it).
A loop runs `windows/cl-pty-proxy/target/release/cl-pty-proxy`, or the binary
`CL_PROXY_BIN` names; without one, `claude-loop start` refuses and says how to
build it. The Windows specifics (ConPTY, win32-input-mode) are in
[`PTY-PROXY-WINDOWS.md`](./PTY-PROXY-WINDOWS.md).

On Unix (`src/unix_main.rs`):

- `openpty` + spawn claude on the inner PTY (the `portable-pty` crate).
- `termios` raw mode on the proxy's stdin, restored on exit, so keystrokes
  pass through byte-for-byte.
- The window size is read with `TIOCGWINSZ` and kept in sync onto claude's
  PTY (resize propagation).
- `loop.sock` (`src/ws_client.rs`): proxy events out, `inject` frames in.
- Claude's exit code is the proxy's exit code.
- **Fail-safe**: if PTY allocation or the spawn fails, the proxy `exec`s
  claude directly — the live pane is never bricked.

The keystroke logic — AFK-combo detection, the first-combo buffering,
presence, ESC-takeover, the reload hotkey — lives in a **pure decider**
(`src/core.rs`) with no I/O: it takes a keystroke (or an idle tick) and a
clock and **returns the actions**; the I/O glue executes them. That seam is
what makes it testable without a PTY: `cargo test`.

A single implementation is deliberate. The Python proxy that ran on Unix
before it kept a second copy of the same classifier, and the two drifted: a
terminal reply (tmux's `ESC P >|tmux …` answer to claude's version probe) was
classified as a bare ESC keypress, so every loop start looked like a human
pressing Escape and armed NOT-AFK for ten minutes.

## How it's wired

- `cli.ts` launches the pane as `<cl-pty-proxy> -- claude …` instead of
  `claude …`. Only affects **newly started** loops.
- Wake injection rides `loop.sock` (an `inject` frame), not `tmux send-keys`.
- The fragile `lastSendAt` / `recentlySentKeys` send-time heuristics are
  gone — the proxy reports real keystrokes, busy included.
- `proxyIsAlive` (a PID-stamped `proxy-alive` marker) is the ground truth for
  who paints the bar's human segment; `claude-loop health <loop>` reports
  whether the proxy is running.

## Diagnostic

- `CL_PROXY_DEBUG=1` prints every byte run the proxy reads, in hex, to its
  stderr; `CL_PROXY_DEBUG_FILE=<file>` appends the same lines to a file.
- The proxy does not write to a session capture (below): a capture holds the
  pane timeline only.

### Unified session capture — `CL_CAPTURE=1`

`CL_CAPTURE=1` records a session into `<state_dir>/capture/` so it can be
replayed later. It supersedes the scattered debug logs (`CL_BAR_PAINT_LOG`),
which keep working as deprecated aliases. The timeline is NDJSON, stamped with
an epoch-seconds `t`:

```
<state_dir>/capture/
  panes.ndjson     # timer: one row per distinct pane frame → {t, kind:"pane", file}
  panes/<ms>.txt   # the pane frames themselves (referenced by `file`, not inlined)
```

Enable it on a running loop with
`claude-loop reload <name> --set CL_CAPTURE=1` (the env is patched before the
respawn). The capture is append-only — it's scoped to the session you want
to record, so delete the dir when done.

That append-only shape is why it does **not** replace the rotating pane cache
(`claude_loop.pane_cache_frames`, see [`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md)).
The two answer different questions: a capture records a repro you decided in
advance to record, keeping the cursor alongside each frame; the cache runs in
the background with a bounded window so there is always a recent corpus for a
detector that started lying, whether or not anyone saw it coming.

**Inspecting a capture — `bin/cl-capture`.** A whole capture dir is far too
large to read raw (full-screen pane dumps). `cl-capture` (a zero-dependency
Python script) reads it by `t` and exposes context-frugal views:

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

## Limitations

- Needs the built binary: a Rust toolchain (`cargo`) on the loop host, or
  `CL_PROXY_BIN` pointing at a binary built elsewhere.
- Only printable-text keystrokes flip the badge; navigation/control keys
  are intentionally ignored.
