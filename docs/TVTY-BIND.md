# tvty and claude-loop: one Claude, two modes, two clients

This page is the contract between tvty and claude-loop over one agent's
Claude: where it runs, who watches it or drives it, and how to go from one
combination to another without breaking the session.

## Two axes

- **The mode** is where Claude runs: in a **tmux** session, or on the
  daemon's **session host** ([`SESSION-HOST.md`](./SESSION-HOST.md)). It is a
  setting, `claude_loop.session` (`host` by default; global, then per project),
  and `--host` / `--tmux` on a start choose one.
- **The client** is who watches or drives it: **claude-loop** in a terminal,
  or **tvty**. Any number of clients at once.

The two are independent: every client works with every mode. Claude runs in
one place at a time, and a client arriving never moves it or restarts it.

## What each gesture does

| Where Claude is | `claude-loop` in the folder | tvty |
|---|---|---|
| Nowhere | starts it in the configured mode, and attaches | `session.start`, in the configured mode or its `mode` |
| On the session host | attaches as a **copy**; `--force` attaches with the controls | attaches through `attach.socket` |
| In tmux | attaches as a **copy** (`tmux attach -r`); `--force` attaches with the controls | attaches through tmux |

- **A copy** watches: it types nothing and never resizes the session. Detach
  with Ctrl-B D, as from any attach; a copy on the session host also leaves on
  Ctrl-C or Ctrl-D, which would reach nothing anyway. claude-loop shows a copy
  plainly: on the host, a reverse-video bar on the terminal's last row and the
  terminal's title; in tmux, `👁 COPY` at the head of the status line, which
  tmux draws for the read-only client alone. tvty shows it its own way.
- **The controls** are shared, as tmux shares them: every interactive client
  types, and the session's size follows the last one that typed, pasted or
  took focus ([`LOOP-HOST.md`](./LOOP-HOST.md), *Size*). Taking them demotes
  nobody.
- **Nothing ever starts a second Claude** for the same folder and agent:
  `--force` takes the controls of the running one. To start fresh,
  `claude-loop rm` it first.
- **Off a terminal**, or with `--no-attach`, a start where Claude already runs
  is refused, saying where it runs and how to attach.
- `claude-loop attach [loop]` attaches with the controls, `--read-only` as a
  copy, whatever the mode.

## Changing mode

Changing mode moves Claude, so it is the one gesture that stops it — when
idle, and it comes back with the same conversation:

- `claude-loop restart --resume <loop> --host` (or `--tmux` back);
- a loop stays in its mode across later restarts; `claude-loop rm` stops it.

The loop's state (wakes, AFK, backlog, wait credit) is aiball's and carries
over.

## What clients see

- An agent's state says where its loop runs: `session.host` is `daemon` (on
  the host, with its `attach.socket`) or `tmux` (with the tmux session name).
- An agent's bar carries `attach` whatever the mode
  ([`LOOP-HOST.md`](./LOOP-HOST.md), *Finding a loop's socket*):

  ```json
  "attach": { "socket": "/…/attach.sock" }              // attachable from this machine
  "attach": { "socket": null, "reason": "remote" }      // on another machine: not attachable
  "attach": { "socket": null, "reason": "no_socket" }   // a loop in tmux: attach through tmux
  ```
- When Claude restarts in the same place, clients get
  `exited {restarting: true}` and stay attached; `closed` means the session is
  over.
- The keys: a key received through the attach socket is a human's key, as one
  typed in tmux (AFK, presence); a mouse or focus report is not; what the loop
  injects never is ([`LOOP-HOST.md`](./LOOP-HOST.md), *Input*).

## This machine only

The attach socket is local. An agent whose loop runs on another machine,
behind a proxy node, is visible on the bus but not attachable: its bar carries
`attach: { socket: null, reason: "remote" }`, so tvty can say so instead of
failing. `remote` never falls back to tmux.

## What tvty reads and calls

| | |
|---|---|
| Reads | `agent.*.state`, `agent.*.bar`, `session.*.state` (bus subjects) |
| Calls | `session.start`, `session.stop`, `consumer.restart_claude` |
| Attaches | the socket in `attach.socket`, with the protocol of [`LOOP-HOST.md`](./LOOP-HOST.md); a loop in tmux through tmux |
