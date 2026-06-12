# Phase 2 — Linux port audit

Sub-ticket #941 (parent #768).

## Status

Phase 1 (Windows parity) shipped in PR #76. The proxy:
- Emits proxyEvents (`afk_key` / `typing` / `touch_marker`) over `loop.sock` ws
- Receives `inject`→PTY + `view`→cache (no paint, BarRenderer TS owns)
- Heartbeat #769 + 1s reconnect
- No state machine local, no fallback file writes (= conforming to #924 thin contract)

## What Linux needs

The current binary is Windows-only at the system layer. To run on Linux:

### Files affected

| File | LOC | Windows-specific items | Linux equivalent |
|---|---|---|---|
| `Cargo.toml` | 43 | `windows-sys` gated on `cfg(windows)` | Add `libc`+`nix` gated on `cfg(unix)` ✓ done |
| `core.rs` | 1013 | `win32_to_vt` + `split_units` (parses win32-input-mode) | Skip — Linux terminals send raw VT directly |
| `ws_client.rs` | 236 | `resolve()` reads `<sd>/loop.sock.addr` (TCP port+token) | Branch `cfg(unix)`: connect to `<sd>/loop.sock` (UDS) |
| `main.rs` | 704 | 15 `cfg(windows)` blocks (see below) | New Unix equivalents |

### main.rs `#[cfg(windows)]` inventory

1. **Imports** (lines 52-71) — `windows_sys::Win32::*` (Foundation, Pipes, Console, Storage). Linux ignores.
2. **`ConsoleIo`** struct (lines 224-297) — Console mode setup (raw VT input, UTF-8 codepage, restore on exit).
   - Linux equivalent: `termios` struct via `nix::sys::termios` (`tcgetattr`+`tcsetattr`). Drop ICANON/ECHO/IEXTEN/ISIG, set `VMIN=1 VTIME=0`.
3. **`read_handle` / `write_handle_all`** (lines 299-360) — Raw `ReadFile`/`WriteFile` on console handles to avoid VT translation.
   - Linux: direct `std::io::stdin().read()` / `stdout().write_all()`. No translation issue.
4. **`SendHandle`** wrapper (line 318) — Mark `HANDLE` as `Send` across threads.
   - Linux: `RawFd` is already `Send`.
5. **`run_inject_server`** (line 338) — Named pipe `\\.\pipe\cl-inject-<name>` server thread.
   - Linux: NOT needed. Phase 1's `ws_client.rs` already receives `inject` over ws → master. So just drop the named-pipe server on Unix.
6. **`real_main`** (line 421) — Main loop using `ConsoleIo` + 2 threads (stdin reader + claude reader).
   - Linux: New `real_main_unix` using `nix::poll::poll` (or `mio`) + termios raw mode.
7. **`console_window_size`** (line 675) — `GetConsoleScreenBufferInfo`.
   - Linux: `nix::pty::tcgetwinsize` or raw `ioctl(TIOCGWINSZ)`.
8. **`run_direct`** (line 693) — Fallback exec when ConPTY init fails.
   - Linux: `Command::exec` (POSIX exec replacing the process).

### Estimate

| Slice | LOC | Risk | Notes |
|---|---|---|---|
| 2A (this) | ~80 | low | Cargo deps + audit doc + scaffold |
| 2B (Unix pty + termios) | ~200 | medium | `pty_unix.rs` module + `run_unix.rs` |
| 2C (UDS transport) | ~80 | low | branch in `ws_client.rs::resolve`/`connect` |
| 2D (CI matrix + tests) | ~50 | low | `cl-pty-proxy-build.yml` |

Total: ~400 LOC new Rust.

## Sequencing

The `is_typing_keystroke` + AFK combo classification (in `core.rs`) is THE primary pure logic. It must be byte-identical to `pty-proxy.py:_is_typing_keystroke`. The Windows version parses win32-input-mode INTO raw VT before classifying ; on Linux we get raw VT directly. So core.rs's classification IS reusable on Unix as-is — the only Windows-specific layer is the win32-input-mode parser which Linux skips entirely.

Decoupling :
- Linux `main_unix.rs` reads stdin bytes → calls `core::is_typing_keystroke` / `core::AfkDetector::feed` directly (skipping `split_units` + `win32_to_vt`)
- Same Decider verdict → same proxyEvents emitted via `ws_client`
- Inject arrives from `ws_client`'s `inbound` channel → write to master fd

So conceptually Linux is SIMPLER than Windows (no nested ConPTY, no input-mode parsing). The Rust work is just system-glue.

## Out of scope (= Phase 3)

- Wiring `claude-loop` Linux to launch the Rust binary
- Removing `pty-proxy.py`
- Verifying parity at runtime
