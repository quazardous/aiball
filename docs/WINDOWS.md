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

## Connecting a new client (a GUI, a script)

Without a Unix socket, a client authenticates with a bearer token, the same way
the CLI does:

1. **Find the token**: `AIBALL_TOKEN` if set, else the `export AIBALL_TOKEN=…`
   line of `%USERPROFILE%\.local\share\aiball\cli-env` (written when the human
   account is created; see
   [Transport: TCP, not UDS](./WIN-INSTALL.md#transport-tcp-not-uds)). The CLI
   does exactly this in `bin/launcher.js`.
2. **Find the daemon**: `AIBALL_URL` if set, else `http://127.0.0.1:7777`
   (the daemon's `-Port` at install; the clients read `AIBALL_URL`, not the port).
3. **Send it**: `Authorization: Bearer <token>`, or `?token=` where headers
   cannot be set. The bus authenticates once, on the request that opens the
   connection: see [`API-BUS.md` — Connecting](./API-BUS.md#connecting).

A client that shares an agent with claude-loop also needs
[`TVTY-BIND.md`](./TVTY-BIND.md): which of the two holds the agent's Claude.

## Not working on Windows yet

- **`aiball reload`** is refused: it is reserved for the local socket, which
  Windows does not have. The same restriction applies to the bus's loop
  controls (`loop.list`, `loop.restart`, `loop.wake`). `aiball restart` works.
- **Session host mode** (`session: host`) relies on Unix sockets. Start loops
  in tmux mode: `claude-loop start --tmux`.
- **`claude-loop stop`** ends the loop's kernel but can leave the psmux session
  and Claude running; `claude-loop rm` then cleans up.
- **`claude-loop tail -f` / `log -f`** need a `tail` command, absent from
  PowerShell and cmd. Run them from Git Bash.
- **`relocate`** does not yet recognise Windows paths below the old folder.
- **Restoring a backup** while the tray runs: quit the tray first, or it
  restarts the daemon during the restore.
- **The mouse wheel over Claude** in a loop scrolls the pane only with a psmux
  newer than 3.3.8. With 3.3.8, enter copy-mode with `prefix + [`.
- **Multi-line arguments** to the `aiball.cmd` shim are cut at the first line
  break by cmd.exe. Run `node bin\aiball …` for those.

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
  `C:/…`, `join()` gives `C:\…`.
- **PowerShell and `.cmd` scripts**: ASCII only. Without a BOM, Windows
  PowerShell 5.1 reads a script in the ANSI code page, and an em dash is enough
  to break parsing. A test checks `install.ps1` and the tray files.
- **Reading a child's output in PowerShell**: set
  `StandardOutputEncoding = UTF8`, or the text arrives in the console's legacy
  code page.
