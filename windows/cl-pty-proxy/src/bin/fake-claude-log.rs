//! Windows fake-claude byte logger — sibling of pty-proxy.py --fake-claude
//! (Unix). Used as the child of cl-pty-proxy in autonomous diagnostic runs:
//! captures EXACTLY what the inner ConPTY delivers when a key arrives at the
//! "claude" position in the chain.
//!
//! Behavior:
//!   - Read stdin in a tight ReadFile loop (no buffering, no echo).
//!   - For every read, append a line to $FAKE_CLAUDE_LOG (default
//!     `fake-claude.log` in cwd): timestamp_ms + len + hex bytes.
//!   - On Ctrl-C (0x03) byte, exit cleanly. Same on EOF.
//!   - Do NOT echo anything back (we don't want to confuse upstream parsers).
//!
//! Compared to the Python one this is dumber: no tty raw-mode work — it inherits
//! the ConPTY-managed stdin from cl-pty-proxy and just logs whatever comes.

use std::env;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

fn log_path() -> String {
    env::var("FAKE_CLAUDE_LOG").unwrap_or_else(|_| "fake-claude.log".to_string())
}

fn ts_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn append_line(path: &str, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

fn main() {
    let path = log_path();
    append_line(&path, &format!("--- fake-claude-log start ts={} ---", ts_ms()));
    let mut stdin = std::io::stdin();
    let mut buf = [0u8; 8192];
    loop {
        match stdin.read(&mut buf) {
            Ok(0) => {
                append_line(&path, &format!("ts={} EOF", ts_ms()));
                break;
            }
            Ok(n) => {
                let hex: Vec<String> = buf[..n].iter().map(|b| format!("{b:02x}")).collect();
                append_line(&path, &format!("ts={} n={} bytes=[{}]", ts_ms(), n, hex.join(" ")));
                if buf[..n].contains(&0x03) {
                    append_line(&path, &format!("ts={} ctrl-c byte seen, exit", ts_ms()));
                    break;
                }
            }
            Err(e) => {
                append_line(&path, &format!("ts={} read err: {e}", ts_ms()));
                break;
            }
        }
    }
}
