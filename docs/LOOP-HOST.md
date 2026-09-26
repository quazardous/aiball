# Loop host: attaching to a loop without tmux

> **Status: a design, not yet implemented.** This page fixes the protocol
> before it is coded, so that clients (tvty first) can be written against it.
> Version 1 of the protocol. The Unix side only; Windows is open (see the end).

Today a loop's session lives in tmux: `claude-loop` starts claude inside a tmux
session, and you watch or drive it with `tmux attach`. The PTY proxy
(`cl-pty-proxy`) already sits between tmux and claude, sees every byte both
ways, and keeps a model of the screen (`CL_SCREEN_MODEL`, see
[`PTY-PROXY.md`](./PTY-PROXY.md)). The next step is for the proxy to **hold the
session itself** and let clients attach to it: a plain terminal (through
`claude-loop attach`), tvty, and later the web UI, several at once.

## Transport

- A Unix socket next to the loop's `loop.sock`: **`<state_dir>/attach.sock`**,
  mode `0600`. It is separate from `loop.sock`, which is the kernel's control
  channel, so the raw output stream never mixes with it.
- The same trust boundary as `loop.sock`: whoever can open the loop's state
  directory can attach ([`SECURITY.md`](./SECURITY.md)). There is no token.
- **Frames**, both ways: `[type: u8][length: u32, big-endian][payload]`. A
  control frame's payload is UTF-8 JSON; output and input are raw bytes.

## Frame types

| Type | Name | Direction | Payload |
|---|---|---|---|
| `0x01` | `hello` | client → proxy | JSON, first frame of a connection |
| `0x02` | `welcome` | proxy → client | JSON |
| `0x03` | `snapshot` | proxy → client | bytes: what repaints the screen |
| `0x04` | `output` | proxy → client | bytes: claude's output, as it comes |
| `0x05` | `input` | client → proxy | bytes: keys, as typed or pasted |
| `0x06` | `resize` | client → proxy | JSON `{rows, cols}` |
| `0x07` | `focus` | client → proxy | JSON `{}` |
| `0x08` | `size` | proxy → client | JSON `{rows, cols}` |
| `0x09` | `screen` | proxy → client | JSON: the screen as text |
| `0x0a` | `exited` | proxy → client | JSON `{code}` |
| `0x0b` | `closed` | proxy → client | JSON `{}` |
| `0x0c` | `error` | proxy → client | JSON `{code, error}` |

A proxy ignores a frame type it does not know; a client does the same.

## Hello and welcome

The client opens with `hello`:

```json
{ "version": 1, "client": "tvty", "mode": "interactive", "view": "stream",
  "scrollback": 1000, "size": { "rows": 40, "cols": 120 } }
```

- `mode`: `interactive` (it may type and resize) or `readonly` (it only watches).
- `view`: `stream` (the snapshot, then the raw output) or `screen` (the screen
  as text, throttled: for small previews, see below).
- `scrollback`: how many lines of history above the screen the snapshot
  carries (`stream` only; 0 for none).
- `size`: the size this client would like (`interactive` only; see *Size*).
- `screen`: with `view: "screen"`, an optional window, e.g.
  `{ "rows": 30, "cols": 100, "from": "bottom" }`.

The proxy answers `welcome`:

```json
{ "version": 1, "loop": "cl-aiball-89c365", "consumer": "claude-aiball-dev",
  "size": { "rows": 40, "cols": 120 }, "pid": 12345 }
```

**Versions.** The proxy speaks its version and every older one it still
supports. If it cannot speak the client's `version`, it sends `error`
(`code: "VERSION_UNSUPPORTED"`, with the versions it speaks) and closes. A
client that receives a `welcome` with a higher version than it knows carries
on: new fields and frame types are only ever added within a version.

## A `stream` client: snapshot, then the stream

Right after `welcome`, one `snapshot` frame: the bytes that, written to a
fresh terminal of the current size, reproduce the screen — the requested
scrollback first, then the visible screen, with its modes (alternate screen,
cursor position and visibility, mouse reporting, bracketed paste). Then
`output` frames, carrying claude's output exactly as the proxy forwards it.

The client keeps its own terminal state (tvty feeds its `alacritty_terminal`
grid): scrollback, selection and search are the client's, and there is no
copy mode on the proxy side.

## A `screen` client: text, for previews

For a small, read-only preview (tvty shows up to about twenty live cards), the
full stream is wasteful. With `view: "screen"`, the proxy sends `screen` frames
instead:

```json
{ "seq": 17, "text": "…rows joined by \\n…", "cursor": { "x": 4, "y": 12 },
  "rows": 30, "cols": 100 }
```

At most 10 per second, and only when the screen changed since the last one.
`text` is the visible screen, as visual rows (like `tmux capture-pane -p`), cut
to the requested window.

## Input: a human's keys

`input` frames from an `interactive` client go to claude **and** through the
same keystroke detection as keys typed in tmux today: typing, a lone ESC, the
AFK combination, the reload key. So AFK, the presence word and the bar's `⌨`
stay right. Pasted text keeps its bracketed-paste markers; the proxy forwards
the bytes as it receives them.

Several clients may type at once — david in a plain terminal, tvty on the same
loop — with no lock, as in tmux. A `readonly` client that sends `input` or
`resize` gets `error` (`code: "READ_ONLY"`); its connection stays open.

## Size: one owner at a time

claude's terminal has one size. The **owner** is the last interactive client
that typed (`input`) or took focus (`focus`); the proxy applies the size that
client asked for (`hello` or `resize`), and announces every change to every
client with `size`. Like tmux's `window-size latest`.

- A `readonly` client never resizes, and never becomes the owner.
- When the owner disconnects, the size stays as it is until another
  interactive client types or takes focus.
- A client smaller than the size in force still receives the whole screen; it
  is up to the client to crop or scroll.

## Liveness and end

- `exited {code}` when claude ends, then `closed`, then the proxy closes the
  connection.
- `closed` alone when the proxy stops for another reason.
- A client that loses the socket without either has lost the proxy: the loop's
  own liveness (the proxy's pid, `proxy-alive`) says whether it is gone.

## What stays open

- **Windows**: whether psmux remains the host there, or the proxy holds the
  session on ConPTY too. This protocol is written for Unix.
- **The web UI** will attach through the daemon, which relays this protocol
  over its own authenticated socket. Described, not specified here.
- **The proxy's crash policy**: holding the session makes the proxy's life the
  session's life. Its release build aborts on panic today; whether it should
  unwind instead is decided before the proxy holds sessions (see
  [`PTY-PROXY.md`](./PTY-PROXY.md), *The screen model*).
