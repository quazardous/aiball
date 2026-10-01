# Loop host: attaching to a loop without tmux

> **Status: a design, not yet implemented.** This page fixes the protocol
> before it is coded, so that clients (tvty first) can be written against it.
> Version 1 of the protocol, on Unix and on Windows (see *Transport*).

Today a loop's session lives in tmux: `claude-loop` starts claude inside a tmux
session, and you watch or drive it with `tmux attach`. The PTY proxy
(`cl-pty-proxy`) already sits between tmux and claude, sees every byte both
ways, and keeps a model of the screen (`CL_SCREEN_MODEL`, see
[`PTY-PROXY.md`](./PTY-PROXY.md)). The next step is for the proxy to **hold the
session itself** and let clients attach to it: a plain terminal (through
`claude-loop attach`), tvty, and the web UI, several at once.

## Finding a loop's socket

A client does not look for the socket on disk: **aiball publishes it**. An
agent's bar (`GET /api/consumers/<agent>/bar`, the `agent.<id>.bar` subject)
carries `attach`:

```json
"attach": { "socket": "/…/attach.sock" }              // attachable from this machine
"attach": { "socket": null, "reason": "remote" }      // on another machine: not attachable
"attach": { "socket": null, "reason": "no_socket" }   // a loop started before its proxy served one
```

`reason` is there exactly when `socket` is `null`. The path is only
meaningful on the loop's own host; the daemon will relay the protocol for a
client elsewhere (the web UI, a remote tvty).

## Transport

- A Unix socket next to the loop's `loop.sock`: **`<state_dir>/attach.sock`**,
  mode `0600`. It is separate from `loop.sock`, which is the kernel's control
  channel, so the raw output stream never mixes with it.
- The same trust boundary as `loop.sock`: whoever can open the loop's state
  directory can attach ([`SECURITY.md`](./SECURITY.md)). On Unix there is no
  token.
- **On Windows** there is no Unix socket every client can reach. The socket is
  still named by its path, but nothing is at the path: beside it,
  `<socket>.addr` holds `{ "port": N, "token": "…" }`. The client connects to
  `127.0.0.1:<port>` and says the token in its `hello` (`token`, below). A
  loopback port is open to every local process: a `hello` without the token,
  or with a wrong one, ends the connection before anything is sent, not even
  an `error`. The directory's ACL keeps `<socket>.addr` to its user (the
  session host's side: [`SESSION-HOST.md`](./SESSION-HOST.md)).
- **Frames**, both ways: `[type: u8][length: u32, big-endian][payload]`. A
  control frame's payload is UTF-8 JSON. `snapshot` and `output` start with an
  8-byte big-endian sequence number, then raw bytes; `input` is raw bytes.

## Frame types

| Type | Name | Direction | Payload |
|---|---|---|---|
| `0x01` | `hello` | client → proxy | JSON, first frame of a connection |
| `0x02` | `welcome` | proxy → client | JSON |
| `0x03` | `snapshot` | proxy → client | `seq: u64` + bytes that repaint the screen |
| `0x04` | `output` | proxy → client | `seq: u64` + claude's output, as it comes |
| `0x05` | `input` | client → proxy | bytes: keys, as typed or pasted |
| `0x06` | `resize` | client → proxy | JSON `{rows, cols}` |
| `0x07` | `focus` | client → proxy | JSON `{}` |
| `0x08` | `size` | proxy → client | JSON `{rows, cols}` |
| `0x09` | `screen` | proxy → client | JSON: the screen, for previews |
| `0x0a` | `exited` | proxy → client | JSON `{code, restarting}` |
| `0x0b` | `closed` | proxy → client | JSON `{ reason? }` |
| `0x0c` | `error` | proxy → client | JSON `{code, error}` |
| `0x0d` | `history_request` | client → proxy | JSON `{before, count}` |
| `0x0e` | `history` | proxy → client | JSON `{first, lines}` |
| `0x0f` | `detach_others` | client → proxy | JSON `{}` |
| `0x10` | `detached_others` | proxy → client | JSON `{count}` |

A proxy ignores a frame type it does not know; a client does the same.

## Hello and welcome

The client opens with `hello`:

```json
{ "version": 1, "client": "tvty", "mode": "interactive", "view": "stream",
  "scrollback": 1000, "size": { "rows": 40, "cols": 120 } }
```

- `mode`: `interactive` (it may type and resize) or `readonly` (it only watches).
- `view`: `stream` (the snapshot, then the raw output) or `screen` (the screen,
  throttled: for small previews, see below).
- `scrollback`: how many lines of history above the screen the snapshot
  carries (`stream` only; 0 for none). More can be fetched later (*History*).
- `size`: the size this client would like (`interactive` only; see *Size*).
- `screen`: with `view: "screen"`, an optional window and format, e.g.
  `{ "rows": 30, "cols": 100, "from": "bottom", "format": "ansi" }`.
- `token`: on Windows, the token of `<socket>.addr` (see *Transport*). On Unix
  it is not sent, and ignored if it is.

The proxy answers `welcome`:

```json
{ "version": 1, "loop": "cl-aiball-89c365", "consumer": "claude-aiball-dev",
  "size": { "rows": 40, "cols": 120 }, "pid": 12345, "history_lines": 5000,
  "features": ["detach_others"] }
```

`history_lines` is how many lines of history the proxy keeps (see *History*).
`features` lists what the proxy does beyond the frames every version-1 proxy
knows: `detach_others` (see *Closing the other clients*). A client offers a
feature only when the proxy lists it, since an older proxy ignores the frame.

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

**Sequence numbers.** Every byte claude writes has a position in one running
count. A `snapshot`'s `seq` is the count it reflects: all output up to it is in
the snapshot, none after. An `output`'s `seq` is the count after its last
byte, so the first `output` after a snapshot carries what follows exactly
that point. A client that sees a gap or an overlap has lost the thread, and
resynchronises by reconnecting.

The client keeps its own terminal state (tvty feeds its `alacritty_terminal`
grid): selection and search are the client's, and there is no copy mode on the
proxy side.

## A slow client

The proxy never waits for a client: claude's output is forwarded at claude's
pace. Each client has a bounded send buffer (4 MiB). When a client falls so
far behind that its buffer would overflow, the proxy drops what is waiting for
it and sends a fresh `snapshot` instead (a resync), then carries on with
`output` from that point. A slow client is never disconnected for being slow,
and never slows claude or the other clients.

## History

The proxy keeps the last `history_lines` lines that scrolled off the top of the
screen. A client that wants more than its snapshot carried — scrolling up with
the wheel, say — asks for it:

```json
{ "before": 1200, "count": 200 }
```

`before` is a line number in the history (0 is the oldest line kept; the
snapshot's scrollback ends just above the screen), and the proxy answers
`history` with up to `count` lines just above it:

```json
{ "first": 1000, "lines": ["…", "…"] }
```

Lines are text with their SGR attributes (colours, bold), one string per
visual row. A request above what is kept returns what there is (possibly
none).

## A `screen` client: previews

For a small, read-only preview (tvty shows up to about twenty live cards), the
full stream is wasteful. With `view: "screen"`, the proxy sends `screen` frames
instead:

```json
{ "seq": 17, "rows": 30, "cols": 100, "cursor": { "x": 4, "y": 12 },
  "lines": ["…", "…"] }
```

At most 10 per second, and only when the screen changed since the last one.
`lines` is the visible screen, one string per visual row (like `tmux
capture-pane -p`), cut to the requested window: plain text by default, or with
its SGR attributes when the client asked `format: "ansi"`, so a preview keeps
its colours.

## Input: a human's keys

`input` frames from an `interactive` client go to claude **and** through the
same keystroke detection as keys typed in tmux today: typing, a lone ESC, the
AFK combination, the reload key. So AFK, the presence word and the bar's `⌨`
stay right. Pasted text keeps its bracketed-paste markers; the proxy forwards
the bytes as it receives them.

**Not every input is a keystroke.** Mouse reports (wheel, clicks, in SGR form)
and focus reports (`CSI I`, `CSI O`) are forwarded to claude but count neither
as a human typing nor as a claim on the size. Only real keys and pastes do.

Several clients may type at once — david in a plain terminal, tvty on the same
loop — with no lock, as in tmux. A `readonly` client that sends `input` or
`resize` gets `error` (`code: "READ_ONLY"`); its connection stays open.

## Size: one owner at a time

claude's terminal has one size. The **owner** is the last interactive client
that typed or pasted (see above: not a mouse or focus report) or took focus
(`focus`); the proxy applies the size that client asked for (`hello` or
`resize`), and announces every change to every client with `size`. Like tmux's
`window-size latest`.

- A `readonly` client never resizes, and never becomes the owner.
- When the owner disconnects, the size passes to the interactive client left
  that was active last (it attached, typed or took focus last), as tmux sizes a
  window to the clients it has; with none left, the size stays as it is.
- A client smaller than the size in force still receives the whole screen; it
  is up to the client to crop or scroll.

## Closing the other clients

An `interactive` client may close every other client of the session: it sends
`detach_others`. Each other client, read-only copies included, gets `closed`
with `reason: "detached_by_other"`, then its connection ends. The session and
the sender carry on, and the sender gets `detached_others` with how many were
closed. A `readonly` client that sends it gets `error` (`code: "READ_ONLY"`)
and nobody is closed.

## Liveness and end

- `exited {code, restarting}` when claude ends. With `restarting: true`, the
  loop starts claude again in the same session: the connection stays open, and
  a fresh `snapshot` follows once the new claude draws. With
  `restarting: false`, `closed` follows and the proxy closes the connection.
- `closed` alone when the proxy stops for another reason.
- So a session is really over when `closed` arrives, and only then.
- A client that loses the socket without either has lost the proxy: the loop's
  own liveness (the proxy's pid, `proxy-alive`) says whether it is gone.

## What stays open

- **The web UI** attaches through the daemon, which is the `stream` client
  here and relays the snapshot, the output and the keys on the bus
  (`agent.<id>.screen`, `agent.pane_keys`, [`API-BUS.md`](./API-BUS.md)):
  `readonly` while the page only watches, `interactive` once typing is
  unlocked.
- **The proxy's crash policy**: holding the session makes the proxy's life the
  session's life. Its release build aborts on panic today; whether it should
  unwind instead is decided before the proxy holds sessions (see
  [`PTY-PROXY.md`](./PTY-PROXY.md), *The screen model*).
