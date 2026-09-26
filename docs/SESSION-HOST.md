# Session host: Claude's sessions without tmux or claude-loop

> **Status: a design, not yet implemented.** This page fixes the host's side
> before it is coded. Clients attach to it with the protocol of
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

## The host outlives the daemon

The daemon restarts on every deploy, and on every change to its code in a dev
checkout. A session must not end with it, so the daemon starts a host
**detached** — its own process session, no parent to die with — and finds it
again when it starts.

Each host keeps its files in `$AIBALL_HOME/hosts/<agent>/`:

| File | What |
|---|---|
| `host.json` | `{ agent, pid, cwd, started_at, version }`, written once the sockets listen |
| `attach.sock` | clients, per [`LOOP-HOST.md`](./LOOP-HOST.md), mode `0600` |
| `control.sock` | the daemon, described below, mode `0600` |

On start, the daemon reads every `host.json`, checks the pid is alive and
answers on `control.sock`, and takes control again; a dead host's directory is
removed. Whoever can open the directory can attach or control: the same
same-user boundary as today's `loop.sock` ([`SECURITY.md`](./SECURITY.md)).

## One host per agent

An agent's session lives in one place at a time: a `claude-loop` loop (while
they remain) or a host. Starting it where it already runs elsewhere is refused
with `HOST_BUSY`, naming where it runs. Where it runs is published with the
agent (`agent.<id>.state`: `host: "claude-loop" | "daemon"`), and a host's
`attach.socket` in the agent's bar, as `LOOP-HOST.md` says.

## The control channel

`control.sock` speaks **JSON-RPC 2.0, one message per line** (newline-delimited
JSON), like the bus. One daemon connection at a time: a new one replaces the
old (the daemon restarted). Nothing on this channel carries Claude's raw
output.

### The daemon calls

| Method | Params | Result |
|---|---|---|
| `host.hello` | — | `{ version, agent, pid, cwd, claude: { pid, running, started_at, exit_code }, size: {rows, cols}, clients }` |
| `host.inject` | `{ text }` | `{}` — writes `text` to Claude's input, as the kernel's wakes do today |
| `host.screen` | — | `{ text, cursor: {x, y}, rows, cols, seq }` — the visible screen, as `getScreen` today |
| `host.start` | `{ argv, env?, cwd? }` | `{ pid }` — starts Claude in the PTY; refused while one runs |
| `host.stop` | `{ signal?: "TERM" \| "INT", timeout_ms? }` | `{ exit_code }` — ends Claude; the host itself stays |
| `host.shutdown` | — | `{}` — Claude stopped first, then the host exits and removes its files |
| `host.resize` | `{ rows, cols }` | `{}` — only while no interactive client owns the size |

### The host notifies

| Notification | Params | When |
|---|---|---|
| `host.screen_changed` | `{ text, cursor, rows, cols, seq }` | the screen changed; at most 4 per second, the latest state |
| `host.keys` | `{ kind, now_ms }` | a client's keys meant something for the loop: `typing`, `lone_esc`, `afk_key`, `reload` — what `proxyEvent`s carry today |
| `host.clients` | `{ count, interactive }` | a client attached or left |
| `host.exited` | `{ code, signal }` | Claude ended; the host waits for `host.start` or `host.shutdown` |

The kernel reads the screen from `host.screen_changed` rather than by polling:
the watchers (busy, prompt, dialogs, compacting) run on each change.

## What clients call, on the bus

Clients never talk to `control.sock`: they ask the daemon, which drives the
host.

| Method | Params | Result, or refusal |
|---|---|---|
| `session.start` | `{ agent, project?, cwd, crew?, size?: {rows, cols}, env? }` | `{ agent, host: "daemon", attach: { socket } }`; `HOST_BUSY` when the agent runs elsewhere |
| `session.stop` | `{ agent }` | `{ agent, exit_code }`: Claude stopped, the host gone |
| `session.handover` | `{ agent, to: "daemon" \| "claude-loop" }` | `{ agent, host, attach? }`; `NOT_IDLE` when Claude stays busy past the delay |

**Size.** `size` is the PTY's size when Claude starts, so a client that starts
a session and attaches right after gets no redraw; without it, 80 × 24 until
an interactive client takes the size.

**Environment.** Claude needs the user's tools (`PATH` with nvm, bun…), which
the daemon, under systemd, may not have. Claude starts with the user's login
environment (read once from the login shell), over which `env` applies —
accepted only from a caller on the local socket, and only for the variables of
an allow-list (`PATH`, `LANG` and `LC_*`, proxies, `NVM_*`, `TERM` and the
like): from another machine, an environment is a way to run code on this one.

## Handover

`session.handover {agent, to: "daemon" | "claude-loop"}` moves a Claude from
one host to the other without losing its conversation:

1. the current side waits until Claude is **idle** (end of turn, empty
   prompt), and refuses after a delay rather than stop it mid-work;
2. it reads the conversation id and stops Claude cleanly;
3. the other side starts Claude in the same working directory with
   `--resume <id>`;
4. the loop's state — wakes, AFK, backlog, wait credit — is aiball's and
   carries over as it is.

Clients attached to the old side get `closed { reason: "handover", to }` and
attach to the new side through the agent's bar; a `closed` without that reason
still means the session is over. When the loop kernel restarts Claude on the
same host, clients get `exited { restarting: true }`, as `LOOP-HOST.md` says.

## Windows

The host holds ConPTY on Windows as `cl-pty-proxy` already does
([`PTY-PROXY-WINDOWS.md`](./PTY-PROXY-WINDOWS.md)); it comes after the Unix
host has proven itself, and replaces psmux there.
