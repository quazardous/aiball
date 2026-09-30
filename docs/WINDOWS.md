# aiball on Windows

A starting point for Windows: how it differs from Linux, where each part is
documented, what a new client needs to connect, and what does not work yet.

## What differs from Linux

| | Linux | Windows |
|---|---|---|
| Daemon transport | Unix socket, no token | **TCP only** (`127.0.0.1:7777`), every client sends a token |
| Supervisor | systemd user unit | a logon scheduled task starts the **tray**, which owns the daemon |
| Multiplexer | tmux | **psmux** (it also installs a `tmux` alias) |
| Loop shell | bash | **Git Bash**, never WSL's `bash` |
| PTY proxy | `cl-pty-proxy` | `cl-pty-proxy.exe`, required: `claude-loop start` refuses without it |
| Installer | `install.sh` | `install.ps1` (pwsh 7; `aiball update` runs it under Windows PowerShell 5.1) |

## Where it is documented

- [`WIN-INSTALL.md`](./WIN-INSTALL.md): installing, the install paths, the
  daemon lifecycle and service modes, rehearsing an install or an upgrade in a
  separate folder (`-Prefix`), troubleshooting. Its section
  [Transport: TCP, not UDS](./WIN-INSTALL.md#transport-tcp-not-uds) explains
  where a local client's token comes from.
- [`WIN-INSTALL.md` — claude-loop on Windows](./WIN-INSTALL.md#claude-loop-on-windows):
  psmux, Git Bash, the one-time Claude prompts, building the ConPTY proxy.
- [`PTY-PROXY-WINDOWS.md`](./PTY-PROXY-WINDOWS.md): the ConPTY proxy itself,
  how it is wired into claude-loop, building and redeploying it.
- [`SECURITY.md`](./SECURITY.md): the trust model. Over TCP a token is always
  required, including from `127.0.0.1`, and it decides the caller's identity.
- [`REMOTE.md`](./REMOTE.md): minting a per-consumer token
  (`aiball auth issue --consumer <id>`) and pointing a loop at a daemon with it.

## Standalone daemon, or proxy node?

The local daemon runs in one of two modes, and tokens work differently in each.
The global config says which: `%USERPROFILE%\.config\aiball\config.yaml`.

- **Standalone**: no `proxy:` block. The board (its database, accounts and
  tokens) is on this machine.
- **Proxy node**: a `proxy:` block with the `url` of a **hub**, another aiball
  (typically a Linux machine), and the node's own token. This daemon keeps no
  board: it relays every call to the hub. See [`REMOTE.md`](./REMOTE.md).

## Connecting a new client (a GUI, a script)

1. **Find the daemon**: `AIBALL_URL` if set, else `http://127.0.0.1:7777`
   (the daemon's `-Port` at install; the clients read `AIBALL_URL`, not the port).
2. **Authenticate as this machine's user**, when the daemon is on this machine
   (a loopback address): read `%USERPROFILE%\.local\share\aiball\machine-secret`
   and send it as the bearer, with who you are in `x-aiball-consumer`. It is the
   TCP counterpart of the Unix socket: the calls that act on this machine
   (`loop.*`, `session.*`, `project.init`, `daemon.reload`) accept it, and a
   token does not. The daemon writes the file at start; send it to a loopback
   address only. See [`SECURITY.md`](./SECURITY.md) and
   [`API-BUS.md` — Connecting](./API-BUS.md#connecting).
3. **Otherwise, a token**: `AIBALL_TOKEN` if set, else the `export
   AIBALL_TOKEN=…` line of `%USERPROFILE%\.local\share\aiball\cli-env`, sent as
   `Authorization: Bearer <token>` (or `?token=` where headers cannot be set).
   A token proves a consumer, not this machine: see [Tokens](#tokens) below.

The aiball CLI, its MCP server and claude-loop do step 2 by themselves
(`src/client.ts`), and prefer it to `cli-env` for a daemon on this machine.

On a **proxy node**, the node checks the machine secret itself and relays with
its own token, so the hub never sees the secret. A client with no credential at
all is also relayed with the node's token and the identity it declares — unless
the node is `strict`.

A client that shares an agent with claude-loop also needs
[`TVTY-BIND.md`](./TVTY-BIND.md): which of the two holds the agent's Claude.

## Tokens

**Any number of tokens can be active at once**, each independent: give each
client its own token, bound to its own consumer (a GUI such as tvty one, each
claude-loop agent another). Revoking or rotating one then never breaks the
others, and the board tells them apart. Where they are made depends on the mode.

### On a standalone daemon

**The first token is created by the daemon**, once: when the human account is
set up (the `/setup` page the installer opens). It issues an **agent-kind
token bound to that human account** and writes it to
`%USERPROFILE%\.local\share\aiball\cli-env` as `export AIBALL_TOKEN=…` —
**only if the file does not exist yet**. It is never rewritten afterwards: a
missing `cli-env` after the first setup stays missing until someone writes it.
Every client that falls back to `cli-env` acts as that human.

More tokens:

```powershell
aiball auth issue --consumer <id> --label "<what it is for>"   # prints a new token, writes nothing
aiball auth list                                               # every active token, with its last use
aiball auth revoke <token-or-prefix>                           # deletes one; the others keep working
```

### On a proxy node

The tokens live on the **hub**, and `aiball auth` refuses to run on the node
(it would work on a local database the node does not use). To give a local
client its own identity:

1. On the hub, mint a token for the client: `aiball auth issue --consumer <id>`,
   or from the hub's web UI.
2. On the node, map it: `aiball proxy token add --consumer <id> --remote <that token>`.
   It prints a **local** token: that is the one the client sends. The node swaps
   it for the hub token on the way out, so the hub sees `<id>`, proved by its
   own token.
3. `aiball restart`: the node reads its mappings at start.

`aiball proxy token list` and `aiball proxy token revoke <local-or-consumer>`
manage the mappings; they live in `%USERPROFILE%\.config\aiball\proxy-tokens.yaml`.

### Where claude-loop keeps a token

A token claude-loop was given (`claude-loop init --aiball-url <url>
--aiball-token <token>`, or the same flags on `start`) is kept in two places:

- `<project>\.aiball.local.yaml`, under `remote:` (`url`, `token`, `consumer`,
  `project`). Git-ignored; read by every later `claude-loop start` in that
  folder, so the flags need not be repeated.
- the loop's own `env` file, `%USERPROFILE%\.claude-loop\<loop>\env`, rewritten
  at each start from the above.

The file modes aiball sets on these files (`0600`) mean nothing on NTFS: on
Windows they are protected only by the user profile's permissions.

## Not working on Windows yet

- **Session host mode** (`session: host`) relies on Unix sockets, so loops run
  in tmux mode (psmux): that is the default on Windows for now. A config that
  sets `session: host` explicitly fails to start a loop (`session.host` refused).
- **Restoring a backup** while the tray runs: quit the tray first, or it
  restarts the daemon during the restore.
- **The mouse wheel over Claude** in a loop scrolls the pane only with a psmux
  newer than 3.3.8. With 3.3.8, enter copy-mode with `prefix + [`.
- **An argument of several lines** is cut at its first line break by cmd.exe,
  which runs the `aiball.cmd` shim. For a ticket's or a comment's text, give it
  from a file or a pipe, which carry it whole from any shell:
  `aiball ticket new --title … --body-file note.md`, or
  `Get-Content note.md -Raw | aiball ticket new --title … --body -`.
  Where PowerShell may run scripts, the installer also writes `aiball.ps1`
  beside `aiball.cmd`, which PowerShell prefers and which passes arguments
  whole. It writes none where the execution policy forbids scripts
  (`Restricted`, the default of Windows PowerShell 5.1): PowerShell would pick
  the `.ps1`, refuse it, and not fall back to the `.cmd`.

## Writing code that runs on Windows

What has broken before, and the helper to use instead:

- **Is the loop's kernel listening?** `selectTransport().reachable(sock)`, never
  `existsSync(loop.sock)`: Windows publishes `loop.sock.addr`, not a socket file.
- **Starting `bin/claude-loop` or `bin/aiball`**: `spawn(process.execPath,
  [script, ...args])`. They are extensionless Node scripts Windows cannot
  execute directly. A test scans `src/` for this.
- **Running a shell command**: `resolveBashCmd()`, never a bare `bash`, which
  can resolve to WSL's.
- **Driving the multiplexer**: `MUX_CMD`, never a hardcoded `tmux`.
- **A `.cmd` / `.bat` file**: Node refuses to spawn it without a shell; see
  `src/launch-argv.ts`.
- **Paths**: compare with `path.relative()`, not string prefixes. git prints
  `C:/…`, `join()` gives `C:\…`. A path read from a JSON text is escaped
  there (`C:\\…`): parse it before comparing.
- **Following a file**: `followLines()` (`src/claude-loop/follow-file.ts`),
  never a spawned `tail`.
- **PowerShell and `.cmd` scripts**: ASCII only. Without a BOM, Windows
  PowerShell 5.1 reads a script in the ANSI code page, and an em dash is enough
  to break parsing. A test checks `install.ps1` and the tray files.
- **Reading a child's output in PowerShell**: set
  `StandardOutputEncoding = UTF8`, or the text arrives in the console's legacy
  code page.
