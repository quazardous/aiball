//! #941 Slice 2B — Linux entry point for the unified Rust proxy.
//!
//! Same role as `main.rs::real_main()` on Windows, but adapted for the Unix
//! ecosystem :
//! - `termios` raw mode (vs ConPTY console handle)
//! - direct `std::io::stdin` / `stdout` (vs `ReadFile`/`WriteFile`)
//! - no named-pipe inject server : `ws_client.rs` already handles inject
//!   over `loop.sock` UDS (Phase 1 wired the same callback shape)
//! - no win32-input-mode parsing : raw VT bytes go straight to the classifier
//!
//! Conforms to the #924 thin contract :
//! - Decider : combo→swallow+toggle_afk · typing→arm_afk_10m+touch_marker · lone-ESC→arm_afk_10m
//! - Émission UNIQUE des proxyEvents sur la ws partagée, pas de fallback file
//! - View→cache (BarRenderer TS owns paint), inject→PTY master

#![cfg(unix)]

use std::env;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, BorrowedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nix::sys::termios::{
    tcgetattr, tcsetattr, ControlFlags, InputFlags, LocalFlags, OutputFlags, SetArg,
    SpecialCharacterIndices, Termios,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::core;
use crate::ws_client;

// ─── env helpers (mirror main.rs) ────────────────────────────────────────────

fn env_f64(key: &str, default: f64) -> f64 {
    env::var(key)
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(default)
}

fn ts_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn loop_sock_path() -> Option<String> {
    // CL_STATE_DIR exported by the bash wrapper / claude-loop launcher.
    let sd = env::var("CL_STATE_DIR").ok()?;
    Some(format!("{sd}/loop.sock"))
}

fn proxy_alive_path() -> Option<String> {
    let sd = env::var("CL_STATE_DIR").ok()?;
    Some(format!("{sd}/proxy-alive"))
}

fn drop_proxy_alive() {
    if let Some(p) = proxy_alive_path() {
        let _ = std::fs::write(&p, "");
    }
}

fn clear_proxy_alive() {
    if let Some(p) = proxy_alive_path() {
        let _ = std::fs::remove_file(&p);
    }
}

// ─── termios raw mode ────────────────────────────────────────────────────────

/// Enable cbreak-like raw mode on stdin : individual bytes flow through, no
/// line buffering / echo / signal generation / control-char interpretation.
/// Returns the original termios so the caller can restore on exit.
fn enable_raw_mode() -> Option<Termios> {
    let raw_fd = std::io::stdin().as_raw_fd();
    // SAFETY: stdin fd lives as long as the process ; borrowing it for a
    // single tcgetattr/tcsetattr call is safe.
    let fd = unsafe { BorrowedFd::borrow_raw(raw_fd) };
    let original = tcgetattr(fd).ok()?;
    let mut raw = original.clone();
    raw.local_flags &= !(LocalFlags::ICANON
        | LocalFlags::ECHO
        | LocalFlags::ISIG
        | LocalFlags::IEXTEN);
    raw.input_flags &= !(InputFlags::ISTRIP
        | InputFlags::INLCR
        | InputFlags::ICRNL
        | InputFlags::IXON
        | InputFlags::IXOFF);
    raw.output_flags &= !OutputFlags::OPOST;
    raw.control_flags |= ControlFlags::CS8;
    raw.control_chars[SpecialCharacterIndices::VMIN as usize] = 1;
    raw.control_chars[SpecialCharacterIndices::VTIME as usize] = 0;
    tcsetattr(fd, SetArg::TCSANOW, &raw).ok()?;
    Some(original)
}

fn restore_termios(original: &Termios) {
    let raw_fd = std::io::stdin().as_raw_fd();
    let fd = unsafe { BorrowedFd::borrow_raw(raw_fd) };
    let _ = tcsetattr(fd, SetArg::TCSANOW, original);
}

/// Stdout window size via `TIOCGWINSZ`. Returns `(rows, cols)`.
fn window_size() -> Option<(u16, u16)> {
    use nix::libc::{ioctl, winsize, TIOCGWINSZ};
    let fd = std::io::stdout().as_raw_fd();
    let mut ws: winsize = unsafe { std::mem::zeroed() };
    if unsafe { ioctl(fd, TIOCGWINSZ, &mut ws as *mut winsize) } == 0 {
        Some((ws.ws_row, ws.ws_col))
    } else {
        None
    }
}

// ─── main loop ────────────────────────────────────────────────────────────────

pub fn run() -> i32 {
    // argv after an optional `--` separator: `cl-pty-proxy -- claude ...`
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(|s| s == "--").unwrap_or(false) {
        args.remove(0);
    }
    if args.is_empty() {
        eprintln!("cl-pty-proxy: no command to run");
        return 2;
    }

    // Resolve argv[0] through PATH (claude). Fallback to raw name.
    let prog = which::which(&args[0])
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| args[0].clone());
    let child_args: Vec<String> = args[1..].to_vec();

    let termios_saved = enable_raw_mode();
    let (rows, cols) = window_size().unwrap_or((30, 120));

    // Allocate openpty + spawn claude. Same fail-safe as Windows : on ANY
    // failure run claude directly so the pane is never bricked.
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
            if let Some(t) = termios_saved.as_ref() {
                restore_termios(t);
            }
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
            if let Some(t) = termios_saved.as_ref() {
                restore_termios(t);
            }
            return run_direct(&prog, &child_args);
        }
    };
    drop(pair.slave);

    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("cl-pty-proxy: clone reader failed ({e})");
            let _ = child.kill();
            if let Some(t) = termios_saved.as_ref() {
                restore_termios(t);
            }
            return run_direct(&prog, &child_args);
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("cl-pty-proxy: take writer failed ({e})");
            let _ = child.kill();
            if let Some(t) = termios_saved.as_ref() {
                restore_termios(t);
            }
            return run_direct(&prog, &child_args);
        }
    };

    let boot_ts = Instant::now();
    let afk_combos = core::parse_afk_spec(&env::var("CL_AFK_SPEC").unwrap_or_default());
    let afk_window_ms = env_f64("CL_AFK_WINDOW_MS", 400.0);
    let esc_takeover = env::var("CL_ESC_TAKEOVER").map(|v| v != "0").unwrap_or(true);

    drop_proxy_alive();

    let writer = Arc::new(Mutex::new(writer));
    // #768 — ws client over UDS : emit proxyEvents + receive inject. None
    // when CL_STATE_DIR is unset (degraded : events dropped, bytes still forward).
    let ws = loop_sock_path().map(|sock| {
        let inj_writer = writer.clone();
        ws_client::start(
            sock,
            ws_client::Callbacks {
                on_inject: Box::new(move |text: &str| {
                    if let Ok(mut w) = inj_writer.lock() {
                        let _ = w.write_all(text.as_bytes());
                        let _ = w.flush();
                    }
                }),
                on_view: Box::new(|_v: &serde_json::Value| { /* cached only ; BarRenderer paints */ }),
            },
        )
    });

    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pair.master));
    let running = Arc::new(AtomicBool::new(true));

    // (1) claude output → our stdout (raw).
    {
        let running = running.clone();
        let mut reader = reader;
        thread::spawn(move || {
            let mut buf = [0u8; 16384];
            let mut out = std::io::stdout();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out.write_all(&buf[..n]).is_err() || out.flush().is_err() {
                            break;
                        }
                    }
                }
            }
            running.store(false, Ordering::Relaxed);
        });
    }

    // (2) human keystrokes → claude PTY through the pure Decider.
    //
    // On Linux, stdin delivers raw VT bytes directly (no win32-input-mode), so
    // we skip `split_units_streaming` and feed the bytes to the classifier as
    // a single Unit per read. The Decider's logic is the same on both
    // platforms ; only the input encoding differs.
    {
        let writer = writer.clone();
        let running = running.clone();
        let ws = ws.clone();
        let boot = boot_ts;
        thread::spawn(move || {
            let mut decider = core::Decider::new(afk_combos, esc_takeover, afk_window_ms);
            let mut buf = [0u8; 8192];
            let mut sin = std::io::stdin();
            while running.load(Ordering::Relaxed) {
                match sin.read(&mut buf) {
                    Ok(0) => break, // stdin EOF
                    Err(_) => break,
                    Ok(n) => {
                        let data = &buf[..n];
                        let now_ms = boot.elapsed().as_secs_f64() * 1000.0;
                        // On Linux, raw bytes == VT bytes (no translation).
                        let unit = core::Unit {
                            raw: data.to_vec(),
                            vt: data.to_vec(),
                            is_down: true,
                        };
                        let v = decider.on_unit(&unit, now_ms);
                        if let Some(ws) = &ws {
                            let ev_ms = ts_now();
                            if v.afk_fired {
                                ws.emit(ws_client::keystroke("afk_key", ev_ms));
                            }
                            if v.typing {
                                ws.emit(ws_client::keystroke("typing", ev_ms));
                                ws.emit(ws_client::marker("touch_marker", ev_ms));
                            }
                            if v.lone_esc {
                                ws.emit(ws_client::keystroke("typing", ev_ms));
                            }
                        }
                        if !v.forward.is_empty() {
                            if let Ok(mut w) = writer.lock() {
                                let _ = w.write_all(&v.forward);
                                let _ = w.flush();
                            }
                        }
                    }
                }
            }
        });
    }

    // (3) housekeeping: propagate resize. The Linux pty doesn't need
    // win32-input-mode tweaking, just keep window size in sync.
    {
        let master = master.clone();
        let running = running.clone();
        thread::spawn(move || {
            let mut last_size = (rows, cols);
            while running.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(200));
                if let Some((r, c)) = window_size() {
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

    // Block on claude ; its exit code becomes ours.
    let status = child.wait();
    running.store(false, Ordering::Relaxed);

    clear_proxy_alive();
    if let Some(t) = termios_saved.as_ref() {
        restore_termios(t);
    }

    match status {
        Ok(s) => s.exit_code() as i32,
        Err(_) => 0,
    }
}

/// Fallback when openpty / spawn fails : exec claude directly so the pane is
/// never bricked. Uses POSIX `exec` to replace the current process.
fn run_direct(prog: &str, args: &[String]) -> i32 {
    use std::process::Command;
    let status = Command::new(prog).args(args).status();
    match status {
        Ok(s) => s.code().unwrap_or(0),
        Err(_) => 127,
    }
}
