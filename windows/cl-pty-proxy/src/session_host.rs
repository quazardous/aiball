//! #3066 — `cl-session-host`: one session (an agent's Claude, or a named
//! command) in a PTY, served to clients on `attach.sock` (docs/LOOP-HOST.md)
//! and driven by the aiball daemon on `control.sock` (docs/SESSION-HOST.md).
//! The daemon starts it detached, so it outlives the daemon's restarts.
//!
//!   cl-session-host --dir <hosts/agent> [--agent A | --name N] [--rows R --cols C] [-- argv...]
//!
//! With an argv, the command starts at once; otherwise it waits for
//! `host.start`.

#[cfg(unix)]
#[path = "core.rs"]
#[allow(dead_code)]
mod core;

#[cfg(unix)]
#[path = "host/frames.rs"]
mod frames;
#[cfg(unix)]
#[path = "host/session.rs"]
mod session;
#[cfg(unix)]
#[path = "host/attach.rs"]
mod attach;
#[cfg(unix)]
#[path = "host/control.rs"]
mod control;

#[cfg(unix)]
fn main() {
    std::process::exit(unix::run());
}

#[cfg(not(unix))]
fn main() {
    eprintln!("cl-session-host: Unix only for now");
    std::process::exit(2);
}

#[cfg(unix)]
mod unix {
    use std::env;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    use crate::control::Control;
    use crate::core;
    use crate::session::Session;

    struct Args {
        dir: PathBuf,
        agent: Option<String>,
        name: Option<String>,
        size: (u16, u16),
        argv: Vec<String>,
        /// #3333 — the host ends with its command (a loop's host): an exit no
        /// restart was asked for shuts it down, files and all.
        exit_with_command: bool,
    }

    fn parse_args() -> Result<Args, String> {
        let mut it = env::args().skip(1);
        let (mut dir, mut agent, mut name, mut rows, mut cols) = (None, None, None, 24u16, 80u16);
        let mut exit_with_command = false;
        let mut argv = Vec::new();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--dir" => dir = it.next(),
                "--agent" => agent = it.next(),
                "--name" => name = it.next(),
                "--rows" => rows = it.next().and_then(|v| v.parse().ok()).unwrap_or(rows),
                "--cols" => cols = it.next().and_then(|v| v.parse().ok()).unwrap_or(cols),
                "--exit-with-command" => exit_with_command = true,
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
        Ok(Args { dir, agent, name, size: (rows.max(1), cols.max(1)), argv, exit_with_command })
    }

    fn listen(path: &Path) -> std::io::Result<UnixListener> {
        let _ = fs::remove_file(path);
        let l = UnixListener::bind(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(l)
    }

    pub fn run() -> i32 {
        let args = match parse_args() {
            Ok(a) => a,
            Err(e) => {
                eprintln!("cl-session-host: {e}");
                return 2;
            }
        };
        if let Err(e) = fs::create_dir_all(&args.dir).and_then(|_| fs::set_permissions(&args.dir, fs::Permissions::from_mode(0o700))) {
            eprintln!("cl-session-host: {}: {e}", args.dir.display());
            return 1;
        }
        let attach_path = args.dir.join("attach.sock");
        let control_path = args.dir.join("control.sock");
        let (attach_l, control_l) = match (listen(&attach_path), listen(&control_path)) {
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
            for f in ["host.json", "attach.sock", "control.sock"] {
                let _ = fs::remove_file(dir.join(f));
            }
            let _ = fs::remove_dir(&dir);
            std::process::exit(0);
        });
        let control = Control::new(session.clone(), hello.clone(), shutdown.clone());
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
        thread::spawn(move || crate::attach::serve(attach_l, s));
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
}
