# Session host: Claude's sessions without tmux or claude-loop

> **Status: the host is built (`cl-session-host`), and the daemon runs sessions
> without an agent (`session.start {name, argv}`). An agent's session comes
> with the loop kernel in the daemon.** This page fixes the host's side and
> what clients call. Clients attach to it with the protocol of
> [`LOOP-HOST.md`](./LOOP-HOST.md); the daemon drives it with the control
> channel described here.

Today an agent's Claude runs inside tmux, started by `claude-loop`, whose
kernel wakes it, types into it and reads its screen, with a PTY proxy in
between. The target replaces the three:

- a **session host**, a small Rust process, holds one Claude in a PTY, serves
  its screen and keys to clients (tvty, `claude-loop attach`, the web through
  the daemon), and keeps running whatever the clients do;
- the **aiball daemon** starts and watches the hosts, and runs the **loop
  kernel** — wakes, injection, AFK, reading the screen, the bar — over each
  host's control channel. Claude's bytes never go through the daemon.

## One host per session

Each agent's session has its own host process: one crash ends one session,
never the others, and a host is a few megabytes. It grows from `cl-pty-proxy`:
its PTY handling, its keystroke detection (typing, a lone ESC, the AFK
combination) and its screen model.

## Sessions without an agent

A host can also hold a **named session without an agent**: any command (a
shell, a tool), no loop kernel, no wakes. It outlives its clients like an
agent's session, which is what tmux gives such terminals today. Its files are
in `$AIBALL_HOME/hosts/term-<name>/`, it is started by `session.start` with
`{ name, argv, cwd }` instead of an agent, and the bus lists these sessions
with the agents' (`session.list`), so clients show them as a group of their
own. Their changes (started, clients, exited, stopped) come on the subject
`session.<name>.state`; `session.*.state` gives them all, those started later
included.

A human may give such a session a **label** (`session.label { name, label }`,
`null` takes it away): what clients show in place of its name. The name stays
its key (its folder, its sockets, `session.stop`). The daemon keeps the label
beside the host's files, so it lasts as long as the session, daemon restarts
included. An agent's session takes none: its name is the agent.

## The host outlives the daemon

The daemon restarts on every deploy, and on every change to its code in a dev
checkout. A session must not end with it, so the daemon starts a host
**detached** — its own process session, no parent to die with — and finds it
again when it starts.

Under systemd, detached is not enough: a service's processes all share its
cgroup, and a restart of the service (`systemctl --user restart aiball`) stops
the whole cgroup. So a daemon running as a systemd service starts each host in
a scope of its own (`systemd-run --user --scope`, unit
`aiball-host-<dir>-<time>`). If the user manager does not answer, the host
starts as before, in the daemon's cgroup.

The same goes for a loop's kernel. A session started through the daemon
(`session.start`) runs `claude-loop start` from the daemon, so its kernel would
be born in the service's cgroup too: a restart would send it SIGTERM, which a
kernel takes for "stop the loop", Claude with it. So a kernel started from
inside a systemd unit goes in a scope of its own as well (unit
`aiball-kernel-<loop>-<time>`). Across a restart it loses the daemon for a few
seconds and reconnects, as after any lost link. If the user manager does not
start a scope, the kernel starts as before.

On Windows the daemon may run in a job, and a job can end every process in it
when it closes. So the daemon starts the host with `--detach`: the host starts
itself again with `CREATE_BREAKAWAY_FROM_JOB` (and no console), then exits, and
the daemon waits for the new host's `host.json` as it would. If the job does
not allow leaving it, the host starts in it all the same, the first one exits
with status `3`, and the daemon logs that the host stays in that job.

The usual case is the tray started at logon: the Task Scheduler runs its task in
a job that forbids leaving it, so every host stays in it. That job ends nothing
on its own: tried with a host started from a scheduled task, the host lives on
when the task ends, when it is deleted, and when it is stopped while it runs
(`Stop-ScheduledTask`). A daemon restart (`aiball restart`) leaves the hosts and
their Claude running. Logging off ends them, as it ends every process of the
user.

Each host keeps its files in `$AIBALL_HOME/hosts/<agent>/`:

| File | What |
|---|---|
| `host.json` | `{ agent, pid, cwd, started_at, version }`, written once the sockets listen |
| `attach.sock` | clients, per [`LOOP-HOST.md`](./LOOP-HOST.md), mode `0600` |
| `control.sock` | the daemon, described below, mode `0600` |
| `attach.sock.addr`, `control.sock.addr` | Windows, in place of the two sockets: `{ "port", "token" }` |
| `label` | a session without an agent: the label a human gave it, written by the daemon |

A Unix socket's path is at most about 100 bytes: the daemon checks
`<dir>/control.sock` fits before it starts a host (not on Windows, where the
sockets are ports).

**On Windows**, there is no Unix socket every client can reach, so the host
listens on the loopback, on a port the system picks, one for each socket, and
writes where, with a token, beside the path the socket would have:
`<dir>/attach.sock.addr`, `<dir>/control.sock.addr`, each
`{ "port": N, "token": "…" }` (a new token for each, each time the host
starts). The sockets keep their names in the contract: a session still says
`attach: { socket: "<dir>/attach.sock" }`, and a client on Windows reads
`<socket>.addr` instead of opening the path. A loopback port is open to every
local process, so the token is what a client must say before anything is sent
to it: in its `hello` on attach ([`LOOP-HOST.md`](./LOOP-HOST.md)), as
`host.auth` on control (below).

The host is the `cl-session-host` binary, built with `cl-pty-proxy`:
`cl-session-host --dir <dir> --agent <id> | --name <name> [--rows R --cols C]
[--exit-with-command] [--detach] [-- argv…]` — with an argv it starts the
command at once, otherwise it waits for `host.start`. An agent's host is
started with `--exit-with-command`: when its command ends and no restart was
asked, the host removes its files and exits. A host left without its command
would read as a live loop. `--detach` is Windows' way out of the daemon's job
(above).

On start, the daemon reads every `host.json`, checks the pid is alive and
answers on `control.sock`, and takes control again; a dead host's directory is
removed. Whoever can open the directory can attach or control: the same
same-user boundary as today's `loop.sock` ([`SECURITY.md`](./SECURITY.md)). On
Windows the host sets that boundary itself: it gives its directory a protected
ACL (full access for its user, nobody else, nothing inherited from above),
which the address files inherit. Where the directory lies gives no protection
of its own: an install outside the profile (`install.ps1 -Prefix`, a
`%PROGRAMDATA%` install) inherits whatever its parent allows.

## One host per agent

An agent's session lives in one place at a time: a `claude-loop` loop (while
they remain) or a host. Starting it where it already runs elsewhere is refused
with `HOST_BUSY`, naming where it runs. Where it runs is published with the
agent (`agent.<id>.state`: `host: "claude-loop" | "daemon"`), and a host's
`attach.socket` in the agent's bar, as `LOOP-HOST.md` says.

**On a proxy node**, the host is the node's own, and its hub cannot see it. The
node tells its hub the agents' sessions it holds (`node_sessions_push` on its
connection to the hub, at each connection and whenever a session starts,
changes or goes), and the hub puts each in its agent's entry
(`agent.<id>.state`, `session`, with `machine: "node:<label>"`). The hub takes
its own host's session first; one an agent has on both is logged. What the hub
keeps of what a node says is in [`SECURITY.md`](./SECURITY.md).

## The control channel

`control.sock` speaks **JSON-RPC 2.0, one message per line** (newline-delimited
JSON), like the bus. Several controllers at once, the daemon and the loop
kernel: each gets its own answers, and every one hears the notifications. A
daemon that restarts connects again; its old connection died with it.
Nothing on this channel carries Claude's raw output.

**On Windows, the first line is `host.auth`**, with the token of
`control.sock.addr`: `{ "jsonrpc": "2.0", "method": "host.auth", "params": {
"token": "…" } }`. The daemon, the loop kernel and Claude's hooks send it as a
notification (no id, so nothing to answer); with an id, the answer is `{}`. Any
other first line, or a wrong token, ends the connection without an answer, and
a controller hears no notification before it is in. On Unix nothing is sent
and nothing changes on the wire: a host started before this still runs after a
daemon update, and does not know the method. A later `host.auth`, and one on a
Unix host, is accepted and does nothing.

### The daemon calls

| Method | Params | Result |
|---|---|---|
| `host.auth` | `{ token }` | `{}` — Windows, the first line (above) |
| `host.hello` | — | `{ version, agent, pid, cwd, claude: { pid, running, started_at, exit_code }, size: {rows, cols}, clients }` |
| `host.inject` | `{ text }` | `{}` — writes `text` to Claude's input, as the kernel's wakes do today |
| `host.screen` | — | `{ text, cursor: {x, y}, rows, cols, seq }` — the visible screen, as `getScreen` today |
| `host.start` | `{ argv, env?, cwd? }` | `{ pid }` — starts Claude in the PTY; refused while one runs |
| `host.stop` | `{ signal?: "TERM" \| "INT", timeout_ms?, restart? }` | `{ exit_code }` — ends Claude: a hangup first (a terminal closing, which a shell obeys), the signal a second later if it still runs, SIGKILL past the timeout, to its whole process group; the host itself stays. With `restart`, attached clients get `exited { restarting: true }` and stay for the next `host.start` |
| `host.shutdown` | — | `{}` — Claude stopped first, then the host exits and removes its files |
| `host.resize` | `{ rows, cols }` | `{}` — only while no interactive client owns the size |

### The host notifies

| Notification | Params | When |
|---|---|---|
| `host.screen_changed` | `{ text, cursor, rows, cols, seq }` | the screen changed; at most 4 per second, the latest state |
| `host.keys` | `{ typing, lone_esc, afk_key, reload, afk_active, now_ms }` | a client's keys meant something for the loop — the PTY proxy's keystroke verdict, what its `proxyEvent`s carry today |
| `host.clients` | `{ count, interactive }` | a client attached or left |
| `host.exited` | `{ code, restarting }` | Claude ended; the host waits for `host.start` or `host.shutdown`, or exits with it (`--exit-with-command`) |

The kernel reads the screen from `host.screen_changed` rather than by polling:
the watchers (busy, prompt, dialogs, compacting) run on each change.

**`host.stop` on Windows**, which has no signals to send. The command runs in a
job of its own, which is what its process group is on Unix: what it starts
goes with it, and the whole job ends if the host itself dies, however it ends.
`INT` is a Ctrl-C typed into the console, a second before the rest; the hangup
is the pseudo-console closing, which sends its processes `CTRL_CLOSE` (Windows
ends them a few seconds later if they do not go by themselves); past the
timeout, the job is ended. Whatever the command left running when it exits is
ended with it.

## What clients call, on the bus

Clients never talk to `control.sock`: they ask the daemon, which drives the
host.

| Method | Params | Result, or refusal |
|---|---|---|
| `session.start` | `{ cwd, project?, agent?, crew?, size?, env?, mode? }` for an agent's loop (with neither `agent` nor `crew`, the folder decides, as `claude-loop start` does; `mode` `host` or `tmux`, the configured `claude_loop.session` by default), or `{ name, argv, cwd, size?, env? }` for a session without an agent | the session: `{ agent \| name, host: "daemon", attach: { socket } }`, or for a loop in tmux `{ agent, host: "tmux", tmux }`; `HOST_BUSY` when the agent (or the name) runs elsewhere |
| `session.host` | `{ agent, argv, cwd, size?, env? }` — local callers only | `claude-loop start --host` runs the command it prepared in the agent's session; the answer adds `control`, the socket its kernel drives |
| `session.stop` | `{ agent }` or `{ name }`, `wait?` | `{ agent \| name, stopping: true }` as soon as the stop is under way — the end comes as the session's state going to null; with `wait`, `{ agent \| name, exit_code }` once the command stopped and the host is gone |
| `session.list` | — | every session on this machine: `{ agent?, name?, argv, cwd, host, attach: { socket }, clients }` |

**Size.** `size` is the PTY's size when Claude starts, so a client that starts
a session and attaches right after gets no redraw; without it, 80 × 24 until
an interactive client takes the size.

**Environment.** Claude needs the user's tools (`PATH` with nvm, bun…), which
the daemon, under systemd, may not have. Claude starts with the user's login
environment (read once from the login shell), over which `env` applies —
accepted only from a caller on the local socket, and only for the variables of
an allow-list (`PATH`, `LANG` and `LC_*`, proxies, `NVM_*`, `TERM` and the
like): from another machine, an environment is a way to run code on this one.

## Changing mode

There is nothing to hand over between clients: claude-loop and tvty attach to
the same Claude, wherever it runs ([`TVTY-BIND.md`](./TVTY-BIND.md)). Moving
Claude between tmux and the host is `claude-loop restart --resume <loop>
--host` (or `--tmux`): Claude stops when idle and comes back with the same
conversation. When the loop kernel restarts Claude on the same host, clients
get `exited { restarting: true }`, as `LOOP-HOST.md` says.

## Windows

The host holds ConPTY on Windows as `cl-pty-proxy` already does
([`PTY-PROXY-WINDOWS.md`](./PTY-PROXY-WINDOWS.md)), and replaces psmux there.
What differs, all above: the sockets are loopback ports with a token in
`<socket>.addr`, `control.sock` starts with `host.auth`, the host sets its
directory's ACL, the command runs in a job, and the host leaves the daemon's
job with `--detach`.

ConPTY opens by asking where the cursor is (`ESC[6n`) and shows nothing until
a terminal answers. Under psmux the terminal does; a host may have no client
yet, so it answers that first question itself from its screen, and does not
pass it on.

A loop runs on the host there by default, as elsewhere; `claude_loop.session:
tmux` (or `claude-loop start --tmux`) keeps it in psmux
([`WINDOWS.md`](./WINDOWS.md)).
