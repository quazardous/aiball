# claude-loop PTY proxy on Windows (ConPTY)

> The Windows sibling of [`docs/PTY-PROXY.md`](PTY-PROXY.md). Same feature —
> tell **a human typing** apart from **claude's output** and from **the
> loop's own wake injection**, live, even while claude is busy streaming —
> but built on **ConPTY** + a **named pipe** instead of POSIX `pty` +
> `AF_UNIX`.

---

## Why a separate implementation

The Unix proxy (`src/claude-loop/pty-proxy.py`) is Python stdlib only:
`pty.fork()`, `termios`, `select`, `AF_UNIX`. **None of those exist on
Windows** — `import pty` itself fails (it pulls in `termios`). So on
Windows the launch path can't reuse it, and a clean room implementation is
needed. Two facts shaped the design:

1. **Python stdlib has no ConPTY.** Replicating the "zero dependency"
   elegance of the Unix proxy in Python on Windows is impossible —
   you'd need `pywinpty` (a native wheel) or hand-rolled `ctypes`. So the
   language advantage is gone; we pick the tool that fits the platform.
2. **psmux is already built on ConPTY** (via the `portable-pty` crate).
   Writing the proxy in Rust on the same `portable-pty` layer means we
   inherit a battle-tested ConPTY abstraction instead of re-deriving it.

Result: `windows/cl-pty-proxy/` — a small Rust binary, **strategy B** (see
"Strategy A" at the bottom for the cleaner long-term plan).

## Where it sits

```
terminal → psmux → ConPTY(psmux) → [cl-pty-proxy] → ConPTY(claude) → claude
```

psmux launches the pane child as `cl-pty-proxy.exe -- claude …` instead of
`claude …`. The proxy allocates a **second, nested ConPTY** that it owns
and runs claude inside it, bridging the three channels:

| Channel | Source → sink | Side effect |
|---|---|---|
| **Human keystrokes** | proxy stdin (from psmux) → claude ConPTY | touch `human-typing` marker + paint `@cl_human` red `stop` (if it's real text), then forward |
| **claude output** | claude ConPTY → proxy stdout (to psmux) | forwarded raw |
| **Wake injection** | named pipe `\\.\pipe\cl-inject-<name>` → claude ConPTY | forwarded, **marker untouched** |

Because the human's keystrokes and claude's output arrive on **physically
distinct handles** (the proxy's stdin vs. the inner ConPTY's output), the
proxy can label every byte by origin — busy or idle — which psmux's
`capture-pane` (rendered output only) never could. The wake moves off
`send-keys` (which would land on the proxy's stdin, indistinguishable from
a human) onto a dedicated **named pipe**, so the only thing on stdin is the
human. Channel separation is physical, not heuristic.

## The win32-input-mode wrinkle (the Windows-specific gotcha)

On Unix the human's keystrokes arrive as raw VT bytes — `v` is `0x76`, so
"is this text?" is a one-byte check. **Under psmux/ConPTY they do not.**
With `ENABLE_VIRTUAL_TERMINAL_INPUT`, conhost delivers keystrokes in
[**win32-input-mode**](https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md)
encoding:

```
ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
```

e.g. typing `h` arrives as `ESC[72;35;104;1;0;1_` — the `104` is the
unicode code point, the `1` after it is key-down. **Every keystroke starts
with ESC**, so the naive "first byte is printable" test classifies all
typing as non-text and never fires the marker.

So `is_typing_keystroke` (in `windows/cl-pty-proxy/src/main.rs`) handles
both encodings:

- **Raw VT** — leading printable byte → text (fallback for non-ConPTY).
- **win32-input-mode** — parse each `_`-terminated CSI, read field 3 (Uc)
  and field 4 (Kd); flag the chunk when any sequence is a **key-down of a
  printable code point**. DSR responses (`…R`), arrows (Uc=0), Enter
  (Uc=13), Ctrl-combos, etc. are correctly ignored.

This is the single most important Windows-specific detail; it's covered by
unit tests (`cargo test`) built from real captured sequences.

> Forwarding is unaffected — the proxy passes the win32-input-mode bytes
> through verbatim and claude's conhost decodes them. Only **detection**
> needed the parser. Likewise, injected raw text (`ver\r`) written to
> claude's ConPTY input is decoded into keystrokes by conhost.

## Markers & status

- `human-typing` — timestamp file still touched on every real text
  keystroke (debug trace), but the live read path is the in-memory IPC
  stamp (`ipc.humanTypingAtMs`, 5 s TTL) fed by the proxy's keystroke
  events over the event channel.
- `@cl_human` — the proxy does **not** paint the bar anymore; it emits
  keystroke events and the TS-side `BarRenderer` is the sole bar writer
  (paints the same transitions as the Unix path). `MUX_CMD` + `CL_TMUX`
  come from the loop env.
- `proxy-alive` — PID-stamped presence marker dropped after a successful
  fork, removed at graceful exit. `state.ts::proxyIsAlive` probes the PID's
  liveness, so a proxy killed with `TerminateProcess` (no cleanup) leaves a
  stale marker that is correctly read as dead — same contract as the Unix proxy.

## Fail-safe

If ConPTY allocation or the claude spawn fails, the proxy runs claude
directly with inherited stdio and propagates its exit code — the live pane
is never bricked (the analogue of the Unix proxy's `os.execvp` fallback).

## How it's wired into claude-loop

- `cli.ts` launch — on `win32`, if `windows/cl-pty-proxy/target/release/
  cl-pty-proxy.exe` exists, the pane runs `exec <proxy.exe> -- <claudeCmd>`;
  otherwise it falls back to launching claude directly. The Python proxy
  branch is gated to non-Windows (its POSIX APIs would crash the pane).
- `state.ts::injectWakePhrase` — on `win32`, gate on `proxyIsAlive(sd)`
  (a named pipe can't be `stat`-ed) and write the wake to
  `injectPipeName(sd)` = `\\.\pipe\cl-inject-<name>` via Node `net`
  (named pipes are first-class in Node `net`, no native dep). Falls back to
  the psmux paste/`send-keys` path otherwise.
- `claude-loop check` — reports the ConPTY proxy as active/inactive on
  Windows, same probe the launch uses.

## Build

Not committed (it's a platform-specific binary; `target/` is gitignored).
Build it with the Rust **GNU** toolchain (no MSVC / VS Build Tools needed):

```powershell
rustup default stable-x86_64-pc-windows-gnu   # one time
cargo build --release --manifest-path windows/cl-pty-proxy/Cargo.toml
```

`claude-loop start` picks it up automatically on the next launch. Without
it, claude-loop still works — it just falls back to the idle-only pane-diff
detection (`claude-loop check` will say so).

### Redeploying on a running setup

`cl-pty-proxy.exe` is held open by every active claude-loop session, so a
plain `cargo build --release` fails with `Access denied (os error 5)` until
every session is stopped. Sequence:

```powershell
claude-loop stop <name>     # repeat for each active session
cargo build --release --manifest-path windows/cl-pty-proxy/Cargo.toml
claude-loop start <name>    # sessions resume with the new binary
```

The "picks it up automatically on next launch" note above describes the
first install — for a steady-state redeploy you have to free the binary
first.

## Parity with the Unix proxy

On Windows, the **proxy is the prioritized path** (project decision): it keeps
accumulating capabilities the bare psmux-native marker (strategy A) can't
cover — notably AFK-combo detection. So the Rust proxy tracks the Unix Python
proxy's feature level.

The decision logic is mirrored as a **pure core** (`src/core.rs`: win32
decode + keystroke split + `AfkDetector` + `Decider` + bar-word), the Rust
analogue of the Python proxy's `_Decider` / `split_keystrokes` / `_AfkDetector`.
It unit-tests without a PTY (`cargo test`), like the Python
`--replay` path. `main.rs` is the I/O glue.

**At parity:** PTY/ConPTY bridge, `proxy-alive` (PID-stamped), `human-typing`
marker, wake injection (named pipe ↔ UDS), resize, exit-code propagation,
fail-safe direct launch, and:

- [x] **3-state bar word + colours.** `stop`(196) / `wait`(178) /
      `loop`(40 green), all `bg=colour16` — the proxy emits the
      keystroke events; the TS `BarRenderer` paints on transition.
- [x] **Arm the presence hold on typing.** A keystroke feeds the AFK
      state machine → bar does `stop → wait → loop`.
- [x] **ESC-takeover.** A bare ESC (gated by `CL_ESC_TAKEOVER`) arms the
      presence hold; ESC-led CSI/SS3 (arrows) don't.
- [x] **Boot-grace `wait`.** Bar reads `wait` during the boot window
      (`CL_BOOT_GRACE_SEC`, `CL_WAIT`/`--no-wait`).
- [x] **AFK detection.** Atomic-combo TOGGLE (`CL_AFK_SPEC` /
      `CL_AFK_WINDOW_MS` debounce) → `afk` marker on↔off, cleared on any other
      keystroke + on boot. The combo is swallowed (never reaches claude).

**The Windows-specific win on the double-frappe bug.** The shared
`AfkDetector` assumes *one keystroke per feed*, but a raw read can coalesce
several (fast key-repeat, or a combo glued to text). On Linux the splitter
re-separates raw VT bytes. On Windows it's intrinsically clean: keystrokes
arrive as **win32-input-mode** (`ESC[Vk;Sc;Uc;Kd;Cs;Rc_`), which is
self-delineating — `split_units` parses one key per `_`-terminated CSI and
decodes each to its VT form (`win32_to_vt`) before the detector, so coalesced
input is split deterministically and `is_down`/modifier info is preserved
(only key-DOWN events drive detection; combo key-UPs are swallowed too).

## Known limitation — double conhost

claude runs under a **second** ConPTY nested inside psmux's ConPTY, so its
output is rendered by two conhosts in series (claude's conhost → proxy
stdout → psmux's conhost). Basic rendering, the DSR cursor handshake, and
resize all work, but complex TUI cases (alt-screen churn, rapid resize) can
glitch. This double-translation tax is inherent to *any* nested-proxy
approach on Windows and is the reason strategy A exists.

---

## Strategy A — psmux-native (implemented, no nested PTY)

The nested proxy reconstructs, at the PTY layer, a separation **psmux
already has natively** — it is the multiplexer, so it already routes human
client keystrokes and `send-keys`/`paste-buffer` injection through
*different code paths*:

- human keystrokes: `input.rs::forward_key_to_active` → `pane.writer.write_all`
- injection: `commands.rs` (`send-keys`/`paste-buffer`) → `send_text_to_active` / `send_paste_to_active`

So instead of a second ConPTY, psmux itself emits the signal. Proposed
upstream as **[psmux/psmux#309](https://github.com/psmux/psmux/pull/309)**:
a session option `@human-input-marker <file>` that psmux touches (mtime,
throttled ~200 ms) on every real human **text** keystroke — never on
`send-keys`/`paste-buffer`. claude-loop sets it at `new-session` to its
existing `<state_dir>/human-typing` path (`cli.ts`), so the existing
`humanIsTyping` / `setTmuxStatus` / `pushState` readers work **unchanged**.

Benefits over strategy B: **no second process, no nested ConPTY, no double
translation, no native dep** beyond psmux. The classifier is trivial too —
psmux already has the *decoded* `KeyCode::Char`, so unlike the proxy it
needs no win32-input-mode parsing.

Version-safe coexistence: older psmux (and tmux) just store the unknown
`@human-input-marker` option and ignore it, so the idle-only pane-diff
fallback still applies — no regression. Once psmux#309 ships in a release,
the pane-diff write can be disabled (version-gated) so the native marker is
the sole source.

Strategy B stays as the fallback for psmux builds without the feature, and
it validated the markers / status wiring that strategy A reuses verbatim.
