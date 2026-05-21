//! claude-loop ConPTY proxy for Windows (#281, strategy B — port of
//! `src/claude-loop/pty-proxy.py`).
//!
//! Interposed between psmux and claude:
//!
//!     terminal -> psmux -> ConPTY(psmux) -> [this proxy] -> ConPTY(claude) -> claude
//!
//! Goal: tell HUMAN typing apart from claude's output AND from our own
//! wake injection — busy included — which the pane-diff heuristic could
//! not (it only runs at idle and confuses human typing vs streaming
//! output). See docs/PTY-PROXY.md for the full rationale; this is the
//! Windows sibling of the Unix Python proxy.
//!
//! How:
//! - Our stdin (the bytes psmux forwards into the pane's ConPTY) = the
//!   HUMAN keystrokes. On every "real text" byte (is_typing_keystroke)
//!   we touch the `human-typing` marker (read by setTmuxStatus) and
//!   repaint the `@cl_human` tmux segment red `stop` instantly, then
//!   forward to claude's PTY. Works whether claude is idle or busy.
//! - claude's output (ConPTY master) -> our stdout, raw.
//! - Wake injection no longer arrives via send-keys (which would land on
//!   our stdin = indistinguishable from a human) but over a Windows
//!   NAMED PIPE (`\\.\pipe\cl-inject-<name>`): we write those bytes to
//!   claude's PTY WITHOUT touching the marker. Physical channel
//!   separation -> no timestamp heuristic.
//!
//! Why ConPTY/Rust (not Python stdlib like the Unix side): Python has no
//! stdlib ConPTY on Windows; portable-pty gives it without a C toolchain,
//! and Rust matches psmux's own PTY layer.
//!
//! Fail-safe: if ConPTY init/spawn fails we run claude directly with
//! inherited stdio so the live pane is NEVER bricked.
//!
//! KNOWN LIMITATION (strategy B): claude runs under a SECOND ConPTY
//! nested inside psmux's ConPTY -> double VT translation. Display fidelity
//! can glitch (resize, alt-screen). Strategy A (psmux paints the signal
//! natively, no nested PTY) is the real fix; this binary exists to ship
//! the feature on Windows now and to validate the end-to-end wiring.

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::process::{Command as StdCommand, Stdio};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    ReadFile, WriteFile, PIPE_ACCESS_DUPLEX,
};
#[cfg(windows)]
use windows_sys::Win32::System::Console::{
    GetConsoleMode, GetConsoleScreenBufferInfo, GetStdHandle, SetConsoleCP, SetConsoleMode,
    SetConsoleOutputCP, CONSOLE_SCREEN_BUFFER_INFO, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT,
    ENABLE_PROCESSED_INPUT, ENABLE_PROCESSED_OUTPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
    ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

const HUMAN_TTL: Duration = Duration::from_secs(5); // follow HUMAN_TYPING_TTL_SEC (state.ts)
const CP_UTF8: u32 = 65001;

/// Opt-in byte tracing to stderr (set CL_PROXY_DEBUG=1). Logs the first
/// bytes of each stdin / inject chunk so the channel classification can be
/// verified without a debugger.
fn dbg_bytes(tag: &str, data: &[u8]) {
    if env::var("CL_PROXY_DEBUG").map(|v| !v.is_empty()).unwrap_or(false) {
        let head: Vec<String> = data.iter().take(12).map(|b| format!("{b:02x}")).collect();
        eprintln!("[cl-pty-proxy] {tag} n={} head=[{}]", data.len(), head.join(" "));
    }
}

// --- state-dir derived paths ------------------------------------------------

fn state_dir() -> Option<String> {
    env::var("CL_STATE_DIR").ok().filter(|s| !s.is_empty())
}

fn marker_path() -> Option<String> {
    state_dir().map(|sd| format!("{sd}/human-typing"))
}

fn proxy_alive_path() -> Option<String> {
    state_dir().map(|sd| format!("{sd}/proxy-alive"))
}

/// Loop name -> the named-pipe address both this proxy and the TS
/// injectWakePhrase compute. CL_NAME is exported by cli.ts; fall back to
/// the basename of CL_STATE_DIR if absent.
fn inject_pipe_name() -> Option<String> {
    let name = env::var("CL_NAME").ok().filter(|s| !s.is_empty()).or_else(|| {
        state_dir().and_then(|sd| {
            sd.replace('\\', "/")
                .rsplit('/')
                .find(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
    })?;
    Some(format!(r"\\.\pipe\cl-inject-{name}"))
}

// --- typing classifier (mirrors is_typing_keystroke in pty-proxy.py) --------

/// A unicode code point counts as "text" (paint `stop`) when it's a
/// printable char — excludes the C0 controls (< 0x20: Enter, Tab,
/// Ctrl-combos) and DEL. Navigation/function keys carry Uc=0, so they
/// never qualify.
fn is_text_codepoint(u: u32) -> bool {
    u >= 0x20 && u != 0x7f
}

fn parse_uint(b: &[u8]) -> Option<u32> {
    if b.is_empty() {
        return None;
    }
    let mut v: u32 = 0;
    for &c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v.checked_mul(10)?.checked_add((c - b'0') as u32)?;
    }
    Some(v)
}

/// True if `data` carries a human TEXT keystroke.
///
/// Two encodings to handle:
/// 1. Raw VT — a leading printable byte (some terminals / non-ConPTY).
/// 2. win32-input-mode — what psmux/ConPTY actually delivers:
///    `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`. Each keystroke is a
///    `_`-terminated CSI; the 3rd field is the unicode code point and the
///    4th is key-down(1)/up(0). We flag a chunk when ANY contained
///    sequence is a key-DOWN of a printable code point. ESC-led control
///    sequences (DSR `…R`, arrows with Uc=0, …) are correctly ignored.
///    (Mirrors is_typing_keystroke in pty-proxy.py, extended for Windows.)
fn is_typing_keystroke(data: &[u8]) -> bool {
    match data.first() {
        None => return false,
        // Raw printable byte → typing.
        Some(&b0) if b0 != 0x1b && b0 >= 0x20 && b0 != 0x7f => return true,
        _ => {}
    }
    // Scan for `_`-terminated win32-input-mode CSI sequences.
    let mut i = 0;
    while i + 1 < data.len() {
        if data[i] == 0x1b && data[i + 1] == b'[' {
            let start = i + 2;
            let mut j = start;
            while j < data.len() && data[j] != b'_' && data[j] != 0x1b {
                j += 1;
            }
            if j < data.len() && data[j] == b'_' {
                let fields: Vec<&[u8]> = data[start..j].split(|&c| c == b';').collect();
                // [Vk, Sc, Uc, Kd, Cs, Rc]
                if fields.len() >= 4 {
                    let uc = parse_uint(fields[2]);
                    let key_down = parse_uint(fields[3]) == Some(1);
                    if key_down {
                        if let Some(u) = uc {
                            if is_text_codepoint(u) {
                                return true;
                            }
                        }
                    }
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    false
}

// --- markers ----------------------------------------------------------------

fn touch_marker() {
    if let Some(p) = marker_path() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = fs::write(&p, format!("{ts}\n")); // mtime is what TS reads
    }
}

/// Presence marker stamped with our PID (ground truth: the pane really
/// runs under the proxy). state.ts::proxyIsAlive probes the PID liveness;
/// we unlink it at cleanup.
fn drop_proxy_alive() {
    if let Some(p) = proxy_alive_path() {
        let _ = fs::write(&p, format!("{}\n", std::process::id()));
    }
}

fn clear_proxy_alive() {
    if let Some(p) = proxy_alive_path() {
        let _ = fs::remove_file(&p);
    }
}

// --- tmux @cl_human painting (#274 parity) ----------------------------------

/// Repaint the `@cl_human` segment of the tmux/psmux bar and force a
/// refresh. No-op when CL_TMUX is unset or the mux call fails — the bar
/// must NEVER be able to break the I/O bridge.
fn paint_human(typing: bool) {
    let target = match env::var("CL_TMUX") {
        Ok(t) if !t.is_empty() => t,
        _ => return,
    };
    let mux = env::var("MUX_CMD").unwrap_or_else(|_| "tmux".to_string());
    let mut it = mux.split_whitespace();
    let prog = match it.next() {
        Some(p) => p,
        None => return,
    };
    let pre: Vec<&str> = it.collect();
    let word = if typing {
        "#[fg=colour196]stop"
    } else {
        "#[fg=colour178]loop"
    };
    let _ = StdCommand::new(prog)
        .args(&pre)
        .args(["set-option", "-t", &target, "@cl_human", word])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = StdCommand::new(prog)
        .args(&pre)
        .args(["refresh-client", "-S"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

// --- raw console handle I/O (Windows) ---------------------------------------
// We do NOT use std::io::stdin/stdout for the pane: on Windows those
// special-case console handles (ReadConsoleW/WriteConsoleW, UTF-16) which
// breaks raw VT byte passthrough. ReadFile/WriteFile on the raw std
// handles give true byte-for-byte transit.

#[cfg(windows)]
struct ConsoleIo {
    stdin: HANDLE,
    stdout: HANDLE,
    in_mode_saved: Option<u32>,
    out_mode_saved: Option<u32>,
}

#[cfg(windows)]
impl ConsoleIo {
    fn setup() -> Self {
        unsafe {
            let stdin = GetStdHandle(STD_INPUT_HANDLE);
            let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            // UTF-8 on both directions so multibyte text round-trips.
            SetConsoleCP(CP_UTF8);
            SetConsoleOutputCP(CP_UTF8);

            let mut in_saved = None;
            let mut in_mode: u32 = 0;
            if stdin != INVALID_HANDLE_VALUE && GetConsoleMode(stdin, &mut in_mode) != 0 {
                in_saved = Some(in_mode);
                // VT input stream, no line buffering / echo / Ctrl-C handling
                // (claude wants the raw bytes).
                let new_in = (in_mode | ENABLE_VIRTUAL_TERMINAL_INPUT)
                    & !ENABLE_LINE_INPUT
                    & !ENABLE_ECHO_INPUT
                    & !ENABLE_PROCESSED_INPUT;
                SetConsoleMode(stdin, new_in);
            }

            let mut out_saved = None;
            let mut out_mode: u32 = 0;
            if stdout != INVALID_HANDLE_VALUE && GetConsoleMode(stdout, &mut out_mode) != 0 {
                out_saved = Some(out_mode);
                // Interpret the VT we forward from claude.
                let new_out =
                    out_mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT;
                SetConsoleMode(stdout, new_out);
            }

            ConsoleIo {
                stdin,
                stdout,
                in_mode_saved: in_saved,
                out_mode_saved: out_saved,
            }
        }
    }

    fn restore(&self) {
        unsafe {
            if let Some(m) = self.in_mode_saved {
                SetConsoleMode(self.stdin, m);
            }
            if let Some(m) = self.out_mode_saved {
                SetConsoleMode(self.stdout, m);
            }
        }
    }

    fn window_size(&self) -> Option<(u16, u16)> {
        unsafe {
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            if GetConsoleScreenBufferInfo(self.stdout, &mut info) == 0 {
                return None;
            }
            let w = info.srWindow;
            let cols = (w.Right - w.Left + 1).max(1) as u16;
            let rows = (w.Bottom - w.Top + 1).max(1) as u16;
            Some((rows, cols))
        }
    }
}

#[cfg(windows)]
fn read_handle(h: HANDLE, buf: &mut [u8]) -> Option<usize> {
    unsafe {
        let mut n: u32 = 0;
        let ok = ReadFile(
            h,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut n,
            ptr::null_mut(),
        );
        if ok == 0 || n == 0 {
            None
        } else {
            Some(n as usize)
        }
    }
}

#[cfg(windows)]
fn write_handle_all(h: HANDLE, mut data: &[u8]) -> bool {
    unsafe {
        while !data.is_empty() {
            let mut n: u32 = 0;
            let ok = WriteFile(h, data.as_ptr(), data.len() as u32, &mut n, ptr::null_mut());
            if ok == 0 || n == 0 {
                return false;
            }
            data = &data[n as usize..];
        }
    }
    true
}

// HANDLE is a raw pointer alias; wrap it so it can cross the thread
// boundary into the worker threads. All access goes through methods (which
// take `self`) so closures capture the whole wrapper, not the bare
// `*mut c_void` field — edition-2021 disjoint capture would otherwise grab
// `self.0` and defeat the `Send` impl below.
#[cfg(windows)]
#[derive(Clone, Copy)]
struct SendHandle(HANDLE);
#[cfg(windows)]
unsafe impl Send for SendHandle {}
#[cfg(windows)]
impl SendHandle {
    fn read(self, buf: &mut [u8]) -> Option<usize> {
        read_handle(self.0, buf)
    }
    fn write_all(self, data: &[u8]) -> bool {
        write_handle_all(self.0, data)
    }
    fn window_size(self) -> Option<(u16, u16)> {
        console_window_size(self.0)
    }
}

// --- named-pipe injection server -------------------------------------------

/// Serve `\\.\pipe\cl-inject-<name>`: for each connecting client, read all
/// bytes and write them to claude's PTY WITHOUT touching the human marker.
/// Sequential single-instance accept loop — wakes are short and serialized.
#[cfg(windows)]
fn run_inject_server(
    pipe_name: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    running: Arc<AtomicBool>,
) {
    let wide: Vec<u16> = pipe_name.encode_utf16().chain(std::iter::once(0)).collect();
    while running.load(Ordering::Relaxed) {
        let pipe = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                ptr::null(),
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            // Can't create the pipe — injection falls back to send-keys on
            // the TS side. Don't spin hot.
            thread::sleep(Duration::from_millis(500));
            continue;
        }
        // Block until a client connects (or is already connected).
        let connected = unsafe { ConnectNamedPipe(pipe, ptr::null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if connected {
            let mut buf = [0u8; 8192];
            // Reads until the client disconnects (read_handle → None).
            while let Some(n) = read_handle(pipe, &mut buf) {
                dbg_bytes("inject", &buf[..n]);
                if let Ok(mut w) = writer.lock() {
                    let _ = w.write_all(&buf[..n]);
                    let _ = w.flush();
                }
            }
        }
        unsafe {
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
        }
    }
}

// --- main -------------------------------------------------------------------

fn main() {
    let code = real_main();
    std::process::exit(code);
}

#[cfg(not(windows))]
fn real_main() -> i32 {
    eprintln!("cl-pty-proxy: Windows-only (use src/claude-loop/pty-proxy.py on Unix)");
    2
}

#[cfg(windows)]
fn real_main() -> i32 {
    // argv after an optional `--` separator: `cl-pty-proxy -- claude ...`
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(|s| s == "--").unwrap_or(false) {
        args.remove(0);
    }
    if args.is_empty() {
        eprintln!("cl-pty-proxy: no command to run");
        return 2;
    }

    // Resolve argv[0] through PATH/PATHEXT (claude.exe). Keep the raw name
    // as the fallback so portable-pty can still try its own resolution.
    let prog = which::which(&args[0])
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| args[0].clone());
    let child_args: Vec<String> = args[1..].to_vec();

    let console = ConsoleIo::setup();
    let (rows, cols) = console.window_size().unwrap_or((30, 120));

    // Allocate the nested ConPTY + spawn claude. On ANY failure, fail-safe
    // to a direct (un-proxied) run so the pane is never bricked.
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("cl-pty-proxy: openpty failed ({e}); running claude directly");
            console.restore();
            return run_direct(&prog, &child_args);
        }
    };

    let mut cmd = CommandBuilder::new(&prog);
    cmd.args(&child_args);
    for (k, v) in env::vars() {
        cmd.env(k, v);
    }
    if let Ok(cwd) = env::current_dir() {
        cmd.cwd(cwd);
    }

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cl-pty-proxy: spawn {prog} failed ({e}); running claude directly");
            drop(pair);
            console.restore();
            return run_direct(&prog, &child_args);
        }
    };
    // Parent doesn't need the slave once the child holds it.
    drop(pair.slave);

    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("cl-pty-proxy: clone reader failed ({e})");
            let _ = child.kill();
            console.restore();
            return run_direct(&prog, &child_args);
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("cl-pty-proxy: take writer failed ({e})");
            let _ = child.kill();
            console.restore();
            return run_direct(&prog, &child_args);
        }
    };

    // Fork succeeded -> we really front claude. Drop the ground-truth
    // marker and claim the `@cl_human` segment at rest before anything else.
    drop_proxy_alive();
    paint_human(false);

    let writer = Arc::new(Mutex::new(writer));
    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pair.master));
    let running = Arc::new(AtomicBool::new(true));
    // Shared human-badge state: (currently shown, last keystroke time).
    let human = Arc::new(Mutex::new((false, Instant::now())));

    let stdin_h = SendHandle(console.stdin);
    let stdout_h = SendHandle(console.stdout);

    // (1) claude output -> our stdout (raw).
    {
        let running = running.clone();
        let mut reader = reader;
        let out = stdout_h;
        thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // claude exited / pipe closed
                    Ok(n) => {
                        if !out.write_all(&buf[..n]) {
                            break;
                        }
                    }
                }
            }
            running.store(false, Ordering::Relaxed);
        });
    }

    // (2) human keystrokes -> claude PTY (+ marker + paint).
    {
        let writer = writer.clone();
        let human = human.clone();
        let running = running.clone();
        let sin = stdin_h;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while running.load(Ordering::Relaxed) {
                match sin.read(&mut buf) {
                    Some(n) => {
                        let data = &buf[..n];
                        dbg_bytes("stdin", data);
                        if is_typing_keystroke(data) {
                            touch_marker();
                            let mut h = human.lock().unwrap();
                            h.1 = Instant::now();
                            if !h.0 {
                                h.0 = true;
                                drop(h);
                                paint_human(true); // loop -> stop, instant
                            }
                        }
                        if let Ok(mut w) = writer.lock() {
                            let _ = w.write_all(data);
                            let _ = w.flush();
                        }
                    }
                    None => {
                        // EOF on stdin — stop forwarding but keep output +
                        // injection bridges alive (claude may still run).
                        break;
                    }
                }
            }
        });
    }

    // (3) wake injection over the named pipe -> claude PTY (no marker).
    if let Some(pipe_name) = inject_pipe_name() {
        let writer = writer.clone();
        let running = running.clone();
        thread::spawn(move || run_inject_server(pipe_name, writer, running));
    }

    // (4) housekeeping: clear the human badge after TTL + propagate resize.
    {
        let human = human.clone();
        let master = master.clone();
        let running = running.clone();
        let out = stdout_h;
        thread::spawn(move || {
            let mut last_size = (rows, cols);
            while running.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(300));
                // Human badge TTL.
                {
                    let mut h = human.lock().unwrap();
                    if h.0 && h.1.elapsed() >= HUMAN_TTL {
                        h.0 = false;
                        drop(h);
                        paint_human(false);
                    }
                }
                // Resize: poll the (psmux) console size, push to claude PTY.
                if let Some((r, c)) = out.window_size() {
                    if (r, c) != last_size {
                        last_size = (r, c);
                        if let Ok(m) = master.lock() {
                            let _ = m.resize(PtySize {
                                rows: r,
                                cols: c,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                    }
                }
            }
        });
    }

    // Block on claude; its exit code becomes ours.
    let status = child.wait();
    running.store(false, Ordering::Relaxed);

    // Cleanup: hand the bar back (loop), drop the marker, restore console.
    paint_human(false);
    clear_proxy_alive();
    console.restore();

    match status {
        Ok(s) => s.exit_code() as i32,
        Err(_) => 0,
    }
}

/// GetConsoleScreenBufferInfo on a raw stdout handle -> (rows, cols).
#[cfg(windows)]
fn console_window_size(stdout: HANDLE) -> Option<(u16, u16)> {
    unsafe {
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
        if GetConsoleScreenBufferInfo(stdout, &mut info) == 0 {
            return None;
        }
        let w = info.srWindow;
        Some((
            (w.Bottom - w.Top + 1).max(1) as u16,
            (w.Right - w.Left + 1).max(1) as u16,
        ))
    }
}

/// Fail-safe: run claude with inherited stdio (no proxy bridge) and
/// propagate its exit code. Keeps the live pane working when ConPTY setup
/// fails — the Windows analogue of the Unix proxy's os.execvp fallback.
#[cfg(windows)]
fn run_direct(prog: &str, args: &[String]) -> i32 {
    match StdCommand::new(prog).args(args).status() {
        Ok(s) => s.code().unwrap_or(0),
        Err(e) => {
            eprintln!("cl-pty-proxy: exec {prog} failed: {e}");
            127
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // win32-input-mode keystroke: ESC [ Vk;Sc;Uc;Kd;Cs;Rc _
    fn w32(vk: u32, sc: u32, uc: u32, kd: u32) -> Vec<u8> {
        format!("\x1b[{vk};{sc};{uc};{kd};0;1_").into_bytes()
    }

    #[test]
    fn raw_printable_is_typing() {
        assert!(is_typing_keystroke(b"a"));
        assert!(is_typing_keystroke(b"ver"));
    }

    #[test]
    fn raw_control_is_not_typing() {
        assert!(!is_typing_keystroke(b"\r")); // Enter
        assert!(!is_typing_keystroke(b"\t")); // Tab
        assert!(!is_typing_keystroke(&[0x7f])); // DEL
        assert!(!is_typing_keystroke(b"")); // empty
    }

    #[test]
    fn win32_text_keydown_is_typing() {
        // 'h' (Uc=104) key down — the real shape psmux delivers.
        assert!(is_typing_keystroke(&w32(72, 35, 104, 1)));
        // 'e', 'l' from the captured trace.
        assert!(is_typing_keystroke(&w32(69, 18, 101, 1)));
        assert!(is_typing_keystroke(&w32(76, 38, 108, 1)));
    }

    #[test]
    fn win32_keyup_alone_is_not_typing() {
        // key-UP of 'h' on its own must not paint stop.
        assert!(!is_typing_keystroke(&w32(72, 35, 104, 0)));
    }

    #[test]
    fn win32_down_and_up_chunk_is_typing() {
        // A single press often arrives as down+up in one read.
        let mut chunk = w32(72, 35, 104, 1);
        chunk.extend(w32(72, 35, 104, 0));
        assert!(is_typing_keystroke(&chunk));
    }

    #[test]
    fn win32_navigation_and_control_not_typing() {
        // Enter (Uc=13) key down.
        assert!(!is_typing_keystroke(&w32(13, 28, 13, 1)));
        // Left arrow: Vk=37, Uc=0.
        assert!(!is_typing_keystroke(&w32(37, 75, 0, 1)));
    }

    #[test]
    fn dsr_response_not_typing() {
        // ESC[1;1R cursor-position report (answer to ESC[6n) must be ignored.
        assert!(!is_typing_keystroke(b"\x1b[1;1R"));
    }
}
