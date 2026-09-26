# tvty and claude-loop: who holds Claude

> **Status: a design, partly built.** Built: the session host and sessions
> without an agent ([`SESSION-HOST.md`](./SESSION-HOST.md)), `HOST_BUSY`, the
> attach protocol served by the host ([`LOOP-HOST.md`](./LOOP-HOST.md)). Not
> yet: an agent's session on the host, `--force`, `session.handover` and the
> `host` field. Each section says which.

This page is the contract between tvty and claude-loop over one agent's
Claude: where it runs, who may watch it and type into it, and how it moves
from one to the other. It gathers what the other pages fix and adds what
they leave out.

## One Claude, one place

An agent's Claude runs in **one place at a time**:

- a **claude-loop** loop (in tmux, or a terminal of its own), or
- the daemon's **session host**, the side tvty starts ("host here").

Starting it where it already runs elsewhere is refused with `HOST_BUSY`,
naming where it runs. *Built.*

The place is published with the agent, in `agent.<id>.state`:

| Field | Value | Status |
|---|---|---|
| `host` | `"claude-loop"`, `"daemon"`, or `null` when it runs nowhere | to add; today it is read from `present` (a loop is connected) and `session` (the host's session) |
| `session` | the host's session, or `null` | built |

tvty shows a small mark on an agent whose Claude runs **elsewhere** than
where tvty would put it, read from `host`. The field is aiball's; the glyph
is tvty's.

There is **no wrapper mode**: tvty never runs `claude-loop` in its own
terminal. The host gives the same thing, and Claude does not die with tvty.

## Watching is not holding

Any number of clients may **watch** a Claude and type into it at once: tvty,
the terminal claude-loop runs in, the web. Watching takes nothing and asks no
confirmation. Only **moving** Claude from one place to the other does.

- **The attach socket**: an agent's bar carries `attach`, the same field
  whatever holds Claude ([`LOOP-HOST.md`](./LOOP-HOST.md), *Finding a loop's
  socket*):

  ```json
  "attach": { "socket": "/…/attach.sock" }              // attachable from this machine
  "attach": { "socket": null, "reason": "remote" }      // on another machine: not attachable
  "attach": { "socket": null, "reason": "no_socket" }   // a loop started before its proxy served one
  ```
- **The size** belongs to the last interactive client that typed, pasted or
  took focus; a read-only client never resizes; a smaller client crops
  ([`LOOP-HOST.md`](./LOOP-HOST.md), *Size*). In the attached mode, the
  terminal claude-loop runs in counts as one of those clients.
- **The keys**: a key received through the attach socket is a human's key,
  as one typed in tmux (AFK, presence); a mouse or focus report is not; what
  the loop injects never is ([`LOOP-HOST.md`](./LOOP-HOST.md), *Input*).

## Taking Claude from the other side

Both ways use the same **handover**, `session.handover {agent, to}`
([`SESSION-HOST.md`](./SESSION-HOST.md), *Handover*):

1. the side that holds Claude waits until it is **idle**, and refuses
   (`NOT_IDLE`) rather than stop it mid-work;
2. it reads the conversation id and stops Claude;
3. the other side starts Claude in the same directory with `--resume <id>`:
   the conversation goes on;
4. the loop's state (wakes, AFK, backlog, wait credit) is aiball's and
   carries over.

The two gestures that start it:

- **From a terminal**: `claude-loop start <agent>` on a Claude the host holds
  is refused, with a message that says where it runs and that
  **`--force`** takes it back. `claude-loop start <agent> --force` runs the
  handover to claude-loop. *To build.*
- **From tvty**: "host here" on a Claude a loop holds asks **a
  confirmation**, which says where it runs and that the loop will give it up;
  then the handover to the daemon. *To build.*

### What clients see

- Clients attached to the side that gives Claude up get
  `closed {reason: "handover", to}`, and attach again through the agent's
  bar once it carries the new socket. tvty waits **30 seconds** for it, then
  shows the session as ended.
- A `closed` without that reason means the session is over.
- When Claude restarts on the same side, clients get
  `exited {restarting: true}` and stay attached.

### When a handover fails

The side that holds Claude keeps it until the other side confirms that
Claude started there:

- if the other side fails, the holder starts Claude again with `--resume`,
  in the same place; clients get `exited {restarting: true}`, not `closed`;
- `session.handover` answers `HANDOVER_FAILED`, with the host that kept
  Claude in `details.host`.

## Discovery

What tvty lists, from the bus alone:

- agents: `agent.*.state` (`host`, `session`, `present`), and each agent's
  bar for `attach.socket`;
- sessions without an agent: `session.*.state`. They have no loop and no
  handover: they run on the host until stopped.

## This machine only

The attach socket is local. An agent whose loop runs on another machine,
behind a proxy node, is visible on the bus but not attachable: its bar
carries `attach: { socket: null, reason: "remote" }`, so tvty can say so
instead of failing. The daemon relaying the attach protocol, which `LOOP-HOST.md`
foresees, is for later.

## Loops in claude-loop

claude-loop's own proxy does not serve `attach.sock`: a loop gets its socket
by moving onto the session host, and claude-loop goes away in the end.

- A new loop: `claude-loop start --host`, or `session.start` (tvty's
  "+ session").
- A running one: `claude-loop restart --resume <loop> --host`. Claude stops
  when idle and comes back on the host with the same conversation; the loop
  stays there across later restarts, and `claude-loop rm` stops its session.

Until then:

- a loop still in claude-loop has `attach: { socket: null, reason:
  "no_socket" }`, and tvty attaches to it through tmux, for that loop only;
  `remote` never falls back to tmux;
- tvty drops tmux once every loop runs on the host.

## What tvty reads and calls

| | |
|---|---|
| Reads | `agent.*.state`, `agent.*.bar`, `session.*.state` (bus subjects) |
| Calls | `session.start`, `session.stop`, `session.handover`, `consumer.restart_claude` |
| Attaches | the socket in `attach.socket`, with the protocol of [`LOOP-HOST.md`](./LOOP-HOST.md) |
