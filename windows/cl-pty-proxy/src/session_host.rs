//! #3066 — `cl-session-host`: one session (an agent's Claude, or a named
//! command) in a PTY, served to clients on `attach.sock` (docs/LOOP-HOST.md)
//! and driven by the aiball daemon on `control.sock` (docs/SESSION-HOST.md).
//! The daemon starts it detached, so it outlives the daemon's restarts.
//!
//!   cl-session-host --dir <hosts/agent> [--agent A | --name N] [--rows R --cols C] [--detach] [-- argv...]
//!
//! With an argv, the command starts at once; otherwise it waits for
//! `host.start`. #3425 — on Windows the sockets are loopback ports with a
//! token, written beside their paths (host/os.rs), and `--detach` starts the
//! host again out of the daemon's job.

#[path = "core.rs"]
#[allow(dead_code)]
mod core;

#[path = "host/frames.rs"]
mod frames;
#[path = "host/os.rs"]
mod os;
#[path = "host/session.rs"]
mod session;
#[path = "host/attach.rs"]
mod attach;
#[path = "host/control.rs"]
mod control;

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::json;

use crate::control::Control;
use crate::session::Session;

fn main() {
    std::process::exit(run());
}

struct Args {
    dir: PathBuf,
    agent: Option<String>,
    name: Option<String>,
    size: (u16, u16),
    argv: Vec<String>,
    /// #3333 — the host ends with its command (a loop's host): an exit no
    /// restart was asked for shuts it down, files and all.
    exit_with_command: bool,
    /// #3425 — start again out of the caller's job, then exit (Windows).
    detach: bool,
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut it = raw.iter().cloned();
    let (mut dir, mut agent, mut name, mut rows, mut cols) = (None, None, None, 24u16, 80u16);
    let (mut exit_with_command, mut detach) = (false, false);
    let mut argv = Vec::new();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next(),
            "--agent" => agent = it.next(),
            "--name" => name = it.next(),
            "--rows" => rows = it.next().and_then(|v| v.parse().ok()).unwrap_or(rows),
            "--cols" => cols = it.next().and_then(|v| v.parse().ok()).unwrap_or(cols),
            "--exit-with-command" => exit_with_command = true,
            "--detach" => detach = true,
            "--" => {
                argv = it.collect();
                break;
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let dir = PathBuf::from(dir.ok_or("--dir is required")?);
    if agent.is_none() && name.is_none() {
        return Err("--agent or --name is required".into());
    }
    Ok(Args { dir, agent, name, size: (rows.max(1), cols.max(1)), argv, exit_with_command, detach })
}

/// The arguments without the host's own `--detach`: the command's, after `--`, untouched.
fn without_detach(raw: &[String]) -> Vec<String> {
    let cut = raw.iter().position(|a| a == "--").unwrap_or(raw.len());
    raw[..cut].iter().filter(|a| a.as_str() != "--detach").chain(&raw[cut..]).cloned().collect()
}

fn run() -> i32 {
    let raw: Vec<String> = env::args().skip(1).collect();
    let args = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("cl-session-host: {e}");
            return 2;
        }
    };
    if args.detach {
        return detach(&without_detach(&raw));
    }
    if let Err(e) = os::make_private_dir(&args.dir) {
        eprintln!("cl-session-host: {}: {e}", args.dir.display());
        return 1;
    }
    let attach_path = args.dir.join("attach.sock");
    let control_path = args.dir.join("control.sock");
    let ((attach_l, attach_token), (control_l, control_token)) = match (os::listen(&attach_path), os::listen(&control_path)) {
        (Ok(a), Ok(c)) => (a, c),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("cl-session-host: cannot listen: {e}");
            return 1;
        }
    };

    // The same keystroke detection as the PTY proxy, set by the same variables.
    let decider = core::Decider::new(
        core::parse_afk_spec(&env::var("CL_AFK_SPEC").unwrap_or_default()),
        env::var("CL_ESC_TAKEOVER").map(|v| v != "0").unwrap_or(true),
        env::var("CL_AFK_WINDOW_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(400.0),
        core::parse_reload_key(&env::var("CL_RELOAD_KEY").unwrap_or_else(|_| "0e".to_string())),
    );
    let name = args.name.clone().or(args.agent.clone()).unwrap_or_default();
    let session = Session::new(args.agent.clone(), name.clone(), args.size, decider);
    if !args.argv.is_empty() {
        if let Err(e) = session.start(&args.argv, &[], None) {
            eprintln!("cl-session-host: {e}");
            return 1;
        }
    }

    let cwd = env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let hello = json!({
        "version": 1,
        "agent": args.agent,
        "name": args.name,
        "pid": std::process::id(),
        "cwd": cwd,
    });
    let dir = args.dir.clone();
    let shutdown: crate::control::Shutdown = Arc::new(move || {
        for f in ["host.json", "attach.sock", "control.sock", "attach.sock.addr", "control.sock.addr"] {
            let _ = fs::remove_file(dir.join(f));
        }
        let _ = fs::remove_dir(&dir);
        std::process::exit(0);
    });
    let control = Control::new(session.clone(), hello.clone(), shutdown.clone(), control_token);
    if args.exit_with_command {
        let s = session.clone();
        // The clients were told (exited, closed) as the command ended; a
        // moment for those frames to go out, then the host goes.
        thread::spawn(move || {
            s.wait_over();
            thread::sleep(Duration::from_millis(200));
            shutdown();
        });
    }

    let s = session.clone();
    thread::spawn(move || crate::attach::serve(attach_l, s, attach_token));
    let c = control.clone();
    thread::spawn(move || c.watch_screen(Duration::from_millis(250), Duration::from_millis(100)));

    // Written last: a host.json means the sockets answer.
    let mut info = hello;
    info["started_at"] = json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let tmp = args.dir.join("host.json.tmp");
    if fs::write(&tmp, info.to_string()).and_then(|_| fs::rename(&tmp, args.dir.join("host.json"))).is_err() {
        eprintln!("cl-session-host: cannot write host.json");
        return 1;
    }
    control.serve(control_l);
    0
}

/// Exit status of a `--detach` whose host could not leave the caller's job:
/// it runs, but ends with the caller (src/sessions/hosts.ts says so).
#[cfg(windows)]
const DETACHED_IN_JOB: i32 = 3;

/// #3425 — the host again, out of the caller's job; this one exits. The caller
/// waits for the new host's host.json, as it would.
#[cfg(windows)]
fn detach(rest: &[String]) -> i32 {
    match os::detach(rest) {
        Ok((_, true)) => 0,
        Ok((_, false)) => DETACHED_IN_JOB,
        Err(e) => {
            eprintln!("cl-session-host: cannot start detached: {e}");
            1
        }
    }
}

/// A Unix host is started in its own scope by the daemon (src/sessions/hosts.ts).
#[cfg(unix)]
fn detach(_rest: &[String]) -> i32 {
    eprintln!("cl-session-host: --detach is for Windows");
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detach_is_the_hosts_option_and_the_command_keeps_its_own() {
        let raw = args(&["--dir", "d", "--agent", "x", "--detach", "--", "claude", "--detach"]);
        let a = parse_args(&raw).unwrap();
        assert!(a.detach);
        assert_eq!(a.argv, args(&["claude", "--detach"]));
        assert_eq!(without_detach(&raw), args(&["--dir", "d", "--agent", "x", "--", "claude", "--detach"]));
    }

    #[test]
    fn a_host_needs_its_folder_and_a_name() {
        assert!(parse_args(&args(&["--agent", "x"])).is_err());
        assert!(parse_args(&args(&["--dir", "d"])).is_err());
    }
}
