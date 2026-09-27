//! #3066 — the session a host holds: one command in a PTY, the screen model fed
//! with everything it writes, and the clients attached to it
//! (docs/LOOP-HOST.md). Everything here is behind one lock, taken briefly: the
//! PTY reader, the clients' readers and the control channel all go through it,
//! and nothing slow (a socket write) happens while it is held — each client has
//! its own writer thread and a bounded queue.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

use crate::frames;
use crate::core::{Decider, Unit, Verdict};

/// A client further behind than this gets a fresh snapshot instead of the backlog.
pub const CLIENT_QUEUE_MAX: usize = 4 * 1024 * 1024;
/// How many lines scrolled off the top the host keeps.
pub const HISTORY_LINES: usize = 5000;

pub struct Queue {
    frames: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}

pub struct Client {
    pub id: u64,
    pub interactive: bool,
    /// `stream` (snapshot then raw output) or `screen` (throttled screen frames).
    pub stream: bool,
    pub screen_opts: Value,
    pub want_size: Mutex<Option<(u16, u16)>>,
    /// #3169 — when it last attached or took the size: who takes it when its owner leaves.
    active: AtomicU64,
    q: Mutex<Queue>,
    cv: Condvar,
}

impl Client {
    fn push(&self, frame: Vec<u8>) {
        let mut q = self.q.lock().unwrap();
        if q.closed {
            return;
        }
        q.bytes += frame.len();
        q.frames.push_back(frame);
        self.cv.notify_one();
    }

    /// A frame for this client alone (an answer, a refusal), in order with the rest.
    pub fn send(&self, frame: Vec<u8>) {
        self.push(frame);
    }

    /// Replace whatever waits with one frame: a client too far behind gets a fresh snapshot.
    fn replace(&self, frame: Vec<u8>) {
        let mut q = self.q.lock().unwrap();
        q.frames.clear();
        q.bytes = frame.len();
        q.frames.push_back(frame);
        self.cv.notify_one();
    }

    fn queued(&self) -> usize {
        self.q.lock().unwrap().bytes
    }

    /// Close after what is queued has gone out.
    pub fn close(&self) {
        let mut q = self.q.lock().unwrap();
        q.closed = true;
        self.cv.notify_one();
    }

    /// The writer thread: sends queued frames in order until closed.
    fn run_writer(self: Arc<Self>, mut sock: UnixStream) {
        loop {
            let frame = {
                let mut q = self.q.lock().unwrap();
                loop {
                    if let Some(f) = q.frames.pop_front() {
                        q.bytes -= f.len();
                        break Some(f);
                    }
                    if q.closed {
                        break None;
                    }
                    q = self.cv.wait(q).unwrap();
                }
            };
            match frame {
                Some(f) => {
                    if frames::write_frame(&mut sock, &f).is_err() {
                        self.q.lock().unwrap().closed = true;
                        break;
                    }
                }
                None => break,
            }
        }
        let _ = sock.shutdown(std::net::Shutdown::Both);
    }
}

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

pub struct ClaudeState {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub exit_code: Option<i64>,
}

struct Inner {
    parser: vt100::Parser,
    /// Every byte the command wrote, counted: `snapshot` / `output` carry it.
    seq: u64,
    /// Bumped on each change of the screen; previews and the control channel compare it.
    screen_rev: u64,
    size: (u16, u16),
    clients: HashMap<u64, Arc<Client>>,
    next_client: u64,
    owner: Option<u64>,
    /// #3169 — a counter, bumped at each attach and each taking of the size.
    activity: u64,
    pty: Option<Pty>,
    claude: ClaudeState,
    /// The next exit is a restart the controller asked for: clients stay attached.
    restarting: bool,
}

/// What the control channel is told, as it happens.
pub type Notify = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct Session {
    inner: Mutex<Inner>,
    exited: Condvar,
    decider: Mutex<Decider>,
    boot: Instant,
    pub agent: Option<String>,
    pub name: String,
    notify: Mutex<Option<Notify>>,
}

fn now_iso() -> String {
    // RFC 3339 in UTC, second precision, without a date crate.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

impl Session {
    pub fn new(agent: Option<String>, name: String, size: (u16, u16), decider: Decider) -> Arc<Self> {
        Arc::new(Session {
            inner: Mutex::new(Inner {
                parser: vt100::Parser::new(size.0.max(1), size.1.max(1), HISTORY_LINES),
                seq: 0,
                screen_rev: 0,
                size,
                clients: HashMap::new(),
                next_client: 1,
                owner: None,
                activity: 0,
                pty: None,
                claude: ClaudeState { running: false, pid: None, started_at: None, exit_code: None },
                restarting: false,
            }),
            exited: Condvar::new(),
            decider: Mutex::new(decider),
            boot: Instant::now(),
            agent,
            name,
            notify: Mutex::new(None),
        })
    }

    pub fn set_notify(&self, n: Option<Notify>) {
        *self.notify.lock().unwrap() = n;
    }

    fn tell(&self, method: &str, params: Value) {
        let n = self.notify.lock().unwrap().clone();
        if let Some(n) = n {
            n(method, params);
        }
    }

    // ---- the command --------------------------------------------------------

    /// Start the command in a fresh PTY at the session's size. Refused while one runs.
    pub fn start(self: &Arc<Self>, argv: &[String], env: &[(String, String)], cwd: Option<&str>) -> Result<u32, String> {
        if argv.is_empty() {
            return Err("argv is empty".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.claude.running {
            return Err("a command already runs in this session".into());
        }
        let (rows, cols) = inner.size;
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {e}"))?;
        let prog = which::which(&argv[0]).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| argv[0].clone());
        let mut cmd = CommandBuilder::new(&prog);
        cmd.args(&argv[1..]);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        match cwd {
            Some(c) => cmd.cwd(c),
            None => {
                if let Ok(c) = std::env::current_dir() {
                    cmd.cwd(c);
                }
            }
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn {prog}: {e}"))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        inner.pty = Some(Pty { master: pair.master, writer, killer, pid });
        inner.claude = ClaudeState { running: true, pid, started_at: Some(now_iso()), exit_code: None };
        // A restart: the screen starts afresh, and each stream client with a snapshot of it.
        let was_restart = std::mem::take(&mut inner.restarting);
        if was_restart {
            inner.parser = vt100::Parser::new(rows, cols, HISTORY_LINES);
            inner.screen_rev += 1;
            let snap = snapshot_frame(&inner, 0);
            for c in inner.clients.values().filter(|c| c.stream) {
                c.push(snap.clone());
            }
        }
        drop(inner);

        let me = self.clone();
        thread::spawn(move || me.pump(reader));
        let me = self.clone();
        thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i64).unwrap_or(-1);
            me.on_exit(code);
        });
        Ok(pid.unwrap_or(0))
    }

    /// Everything the command writes: into the screen model, and to every stream client.
    fn pump(self: Arc<Self>, mut reader: Box<dyn Read + Send>) {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let bytes = &buf[..n];
            let mut inner = self.inner.lock().unwrap();
            inner.parser.process(bytes);
            inner.seq += n as u64;
            inner.screen_rev += 1;
            let seq = inner.seq;
            let frame = frames::encode_seq(frames::OUTPUT, seq, bytes);
            let mut behind = Vec::new();
            for c in inner.clients.values().filter(|c| c.stream) {
                if c.queued() + frame.len() > CLIENT_QUEUE_MAX {
                    behind.push(c.clone());
                } else {
                    c.push(frame.clone());
                }
            }
            if !behind.is_empty() {
                // #LOOP-HOST "A slow client": what waits is dropped, a fresh snapshot replaces it.
                let snap = snapshot_frame(&inner, 0);
                for c in behind {
                    c.replace(snap.clone());
                }
            }
        }
    }

    fn on_exit(&self, code: i64) {
        let mut inner = self.inner.lock().unwrap();
        inner.pty = None;
        inner.claude.running = false;
        inner.claude.exit_code = Some(code);
        let restarting = inner.restarting;
        let exited = frames::encode_json(frames::EXITED, &json!({ "code": code, "restarting": restarting }));
        for c in inner.clients.values() {
            c.push(exited.clone());
        }
        if !restarting {
            // The session is over for its clients; the host waits for start or shutdown.
            let closed = frames::encode_json(frames::CLOSED, &json!({}));
            for c in inner.clients.values() {
                c.push(closed.clone());
                c.close();
            }
            inner.clients.clear();
            inner.owner = None;
        }
        drop(inner);
        self.exited.notify_all();
        self.tell("host.exited", json!({ "code": code, "restarting": restarting }));
        self.tell_clients();
    }

    /// Stop the command, to its whole process group (the PTY makes the command
    /// a session leader: its group is its pid), so nothing it started lives on
    /// out of sight (#3141): SIGHUP first — a terminal closing, which is what
    /// ends an interactive shell, one that ignores SIGTERM (#3158) — then
    /// `signal` a moment later if it is still there, then SIGKILL past
    /// `timeout`. With `restart`, clients stay attached for the next `start`.
    pub fn stop(&self, signal: i32, timeout: Duration, restart: bool) -> Option<i64> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.claude.running {
            return inner.claude.exit_code;
        }
        inner.restarting = restart;
        let pid = inner.pty.as_ref().and_then(|p| p.pid);
        let deadline = Instant::now() + timeout;
        if let Some(pid) = pid {
            signal_group(pid, libc::SIGHUP);
            let after_hup = (Instant::now() + HANGUP_GRACE).min(deadline);
            while inner.claude.running {
                let left = after_hup.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                inner = self.exited.wait_timeout(inner, left).unwrap().0;
            }
            if inner.claude.running {
                signal_group(pid, signal);
            }
        }
        while inner.claude.running {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                // portable-pty's kill is a SIGHUP on Unix: a program that ignores
                // it survives. Past the grace, nothing is asked any more.
                if let Some(pid) = pid {
                    signal_group(pid, libc::SIGKILL);
                }
                if let Some(p) = inner.pty.as_mut() {
                    let _ = p.killer.kill();
                }
                inner = self.exited.wait_timeout(inner, Duration::from_secs(5)).unwrap().0;
                break;
            }
            inner = self.exited.wait_timeout(inner, left).unwrap().0;
        }
        inner.claude.exit_code
    }

    pub fn claude(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        json!({
            "pid": inner.claude.pid,
            "running": inner.claude.running,
            "started_at": inner.claude.started_at,
            "exit_code": inner.claude.exit_code,
        })
    }

    // ---- input ---------------------------------------------------------------

    /// Text from the loop kernel (a wake): straight to the command.
    pub fn inject(&self, text: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let pty = inner.pty.as_mut().ok_or("nothing runs in this session")?;
        pty.writer.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        pty.writer.flush().map_err(|e| e.to_string())
    }

    /// A client's keys. Mouse and focus reports go through as they are and count
    /// for nothing; real keys go through the Decider (typing, AFK, reload) and
    /// make the client the size's owner.
    pub fn input(&self, client: &Arc<Client>, bytes: &[u8]) {
        let report = is_mouse_or_focus_report(bytes);
        let forward = if report {
            bytes.to_vec()
        } else {
            let now = self.boot.elapsed().as_secs_f64() * 1000.0;
            let unit = Unit { raw: bytes.to_vec(), vt: bytes.to_vec(), is_down: true };
            let v = self.decider.lock().unwrap().on_unit(&unit, now);
            self.tell_keys(&v);
            v.forward
        };
        let mut inner = self.inner.lock().unwrap();
        if !report {
            self.take_size(&mut inner, client);
        }
        if let Some(pty) = inner.pty.as_mut() {
            if !forward.is_empty() {
                let _ = pty.writer.write_all(&forward);
                let _ = pty.writer.flush();
            }
        }
    }

    fn tell_keys(&self, v: &Verdict) {
        if !(v.typing || v.lone_esc || v.afk_fired || v.reload_fired) {
            return;
        }
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        self.tell("host.keys", json!({
            "typing": v.typing,
            "lone_esc": v.lone_esc,
            "afk_key": v.afk_fired,
            "reload": v.reload_fired,
            "afk_active": v.afk_active,
            "now_ms": now_ms,
        }));
    }

    // ---- size ----------------------------------------------------------------

    fn take_size(&self, inner: &mut Inner, client: &Arc<Client>) {
        if !client.interactive {
            return;
        }
        inner.owner = Some(client.id);
        inner.activity += 1;
        client.active.store(inner.activity, Ordering::Relaxed);
        let want = *client.want_size.lock().unwrap();
        if let Some(size) = want {
            apply_size(inner, size);
        }
    }

    pub fn focus(&self, client: &Arc<Client>) {
        let mut inner = self.inner.lock().unwrap();
        self.take_size(&mut inner, client);
    }

    pub fn client_resize(&self, client: &Arc<Client>, size: (u16, u16)) {
        *client.want_size.lock().unwrap() = Some(size);
        let mut inner = self.inner.lock().unwrap();
        if inner.owner == Some(client.id) {
            apply_size(&mut inner, size);
        }
    }

    /// The controller's size: only while no interactive client owns it.
    pub fn control_resize(&self, size: (u16, u16)) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.owner.is_some() {
            return false;
        }
        apply_size(&mut inner, size);
        true
    }

    pub fn size(&self) -> (u16, u16) {
        self.inner.lock().unwrap().size
    }

    // ---- clients -------------------------------------------------------------

    /// Attach a client after its `hello`: it gets `welcome`, then its first view.
    pub fn attach(self: &Arc<Self>, sock: UnixStream, hello: &Value, pid: u32) -> Arc<Client> {
        let interactive = hello["mode"].as_str() != Some("readonly");
        let stream = hello["view"].as_str() != Some("screen");
        let want = size_of(&hello["size"]);
        let mut inner = self.inner.lock().unwrap();
        let id = inner.next_client;
        inner.next_client += 1;
        let client = Arc::new(Client {
            id,
            interactive,
            stream,
            screen_opts: hello["screen"].clone(),
            want_size: Mutex::new(if interactive { want } else { None }),
            active: AtomicU64::new(0),
            q: Mutex::new(Queue { frames: VecDeque::new(), bytes: 0, closed: false }),
            cv: Condvar::new(),
        });
        let writer = sock.try_clone().expect("clone a unix stream");
        let c = client.clone();
        thread::spawn(move || c.run_writer(writer));
        let history = history_len(inner.parser.screen_mut());
        client.push(frames::encode_json(frames::WELCOME, &json!({
            "version": 1,
            "loop": self.name,
            "consumer": self.agent,
            "size": { "rows": inner.size.0, "cols": inner.size.1 },
            "pid": pid,
            "history_lines": history,
        })));
        if stream {
            let scrollback = hello["scrollback"].as_u64().unwrap_or(0) as usize;
            client.push(snapshot_frame(&inner, scrollback));
        } else {
            client.push(screen_frame(&inner, &client.screen_opts));
        }
        inner.activity += 1;
        client.active.store(inner.activity, Ordering::Relaxed);
        inner.clients.insert(id, client.clone());
        // The first interactive client of an unowned session takes its size,
        // and hears it with the others (its welcome carried the old one).
        if interactive && inner.owner.is_none() {
            self.take_size(&mut inner, &client);
        }
        drop(inner);
        self.tell_clients();
        client
    }

    pub fn detach(&self, client: &Arc<Client>) {
        client.close();
        let mut inner = self.inner.lock().unwrap();
        inner.clients.remove(&client.id);
        if inner.owner == Some(client.id) {
            inner.owner = None;
            // #3169 — the size passes to the interactive client left that was
            // active last, as tmux sizes a session to the clients it has; with
            // none left, it stays as it is.
            let next = inner.clients.values()
                .filter(|c| c.interactive)
                .max_by_key(|c| c.active.load(Ordering::Relaxed))
                .cloned();
            if let Some(next) = next {
                self.take_size(&mut inner, &next);
            }
        }
        drop(inner);
        self.tell_clients();
    }

    fn tell_clients(&self) {
        let (count, interactive) = {
            let inner = self.inner.lock().unwrap();
            (inner.clients.len(), inner.clients.values().filter(|c| c.interactive).count())
        };
        self.tell("host.clients", json!({ "count": count, "interactive": interactive }));
    }

    pub fn client_count(&self) -> usize {
        self.inner.lock().unwrap().clients.len()
    }

    /// Lines of history just above `before` (0 = the oldest kept), formatted.
    pub fn history(&self, before: usize, count: usize) -> Value {
        let mut inner = self.inner.lock().unwrap();
        let (first, lines) = history_lines(inner.parser.screen_mut(), before, count);
        json!({ "first": first, "lines": lines })
    }

    /// Close every client (the host goes away).
    pub fn close_all(&self) {
        let mut inner = self.inner.lock().unwrap();
        let closed = frames::encode_json(frames::CLOSED, &json!({}));
        for c in inner.clients.values() {
            c.push(closed.clone());
            c.close();
        }
        inner.clients.clear();
    }

    // ---- the screen ------------------------------------------------------------

    /// The visible screen as text, for the loop kernel.
    pub fn screen(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        screen_text(&inner)
    }

    pub fn screen_rev(&self) -> u64 {
        self.inner.lock().unwrap().screen_rev
    }

    /// Send `screen` frames to the preview clients whose screen changed since `last`.
    pub fn push_previews(&self, last: u64) {
        let inner = self.inner.lock().unwrap();
        if inner.screen_rev == last {
            return;
        }
        for c in inner.clients.values().filter(|c| !c.stream) {
            c.push(screen_frame(&inner, &c.screen_opts));
        }
    }
}

fn size_of(v: &Value) -> Option<(u16, u16)> {
    let rows = v["rows"].as_u64()?;
    let cols = v["cols"].as_u64()?;
    if rows == 0 || cols == 0 || rows > 1000 || cols > 1000 {
        return None;
    }
    Some((rows as u16, cols as u16))
}

pub fn parse_size(v: &Value) -> Option<(u16, u16)> {
    size_of(v)
}

fn apply_size(inner: &mut Inner, size: (u16, u16)) {
    if inner.size == size {
        return;
    }
    inner.size = size;
    inner.parser.screen_mut().set_size(size.0, size.1);
    inner.screen_rev += 1;
    if let Some(p) = inner.pty.as_ref() {
        let _ = p.master.resize(PtySize { rows: size.0, cols: size.1, pixel_width: 0, pixel_height: 0 });
    }
    let frame = frames::encode_json(frames::SIZE, &json!({ "rows": size.0, "cols": size.1 }));
    for c in inner.clients.values() {
        c.push(frame.clone());
    }
}

/// Mouse reports (SGR `CSI < … M/m`, X10 `CSI M …`) and focus reports (`CSI I`, `CSI O`).
fn is_mouse_or_focus_report(b: &[u8]) -> bool {
    b.starts_with(b"\x1b[<") || b.starts_with(b"\x1b[M") || b == b"\x1b[I" || b == b"\x1b[O"
}

/// How many history lines the screen holds (it clamps a scrollback request to that).
fn history_len(screen: &mut vt100::Screen) -> usize {
    screen.set_scrollback(usize::MAX);
    let n = screen.scrollback();
    screen.set_scrollback(0);
    n
}

/// History lines `[before - count, before)`, oldest first, as formatted text.
fn history_lines(screen: &mut vt100::Screen, before: usize, count: usize) -> (usize, Vec<String>) {
    let total = history_len(screen);
    let before = before.min(total);
    let first = before.saturating_sub(count);
    let (rows, cols) = screen.size();
    let mut out = Vec::with_capacity(before - first);
    let mut line = first;
    while line < before {
        // Scrolled back by `total - line`, the view's top row is history line `line`.
        screen.set_scrollback(total - line);
        let take = (before - line).min(rows as usize);
        for row in screen.rows_formatted(0, cols).take(take) {
            out.push(String::from_utf8_lossy(&row).into_owned());
        }
        line += take;
    }
    screen.set_scrollback(0);
    (first, out)
}

/// The bytes that reproduce the screen on a fresh terminal: the requested
/// history first (pushed into the client's scrollback), then the screen and
/// its modes.
fn snapshot_frame(inner: &Inner, scrollback: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    if scrollback > 0 {
        // A copy: the history is read by scrolling the model.
        let mut screen = inner.parser.screen().clone();
        let total = history_len(&mut screen);
        let (_, lines) = history_lines(&mut screen, total, scrollback);
        for l in &lines {
            bytes.extend_from_slice(l.as_bytes());
            bytes.extend_from_slice(b"\x1b[0m\r\n");
        }
        // Push them all above the screen before it is drawn.
        for _ in 0..inner.size.0 {
            bytes.extend_from_slice(b"\r\n");
        }
    }
    let screen = inner.parser.screen();
    bytes.extend_from_slice(b"\x1b[H\x1b[2J");
    bytes.extend_from_slice(&screen.state_formatted());
    bytes.extend_from_slice(&screen.cursor_state_formatted());
    frames::encode_seq(frames::SNAPSHOT, inner.seq, &bytes)
}

fn screen_text(inner: &Inner) -> Value {
    let s = inner.parser.screen();
    let (rows, cols) = s.size();
    let text = s.rows(0, cols).collect::<Vec<_>>().join("\n");
    let (cy, cx) = s.cursor_position();
    json!({ "text": text, "cursor": { "x": cx, "y": cy }, "rows": rows, "cols": cols, "seq": inner.screen_rev })
}

/// A preview: the screen's rows, cut to the client's window, plain or with colours.
fn screen_frame(inner: &Inner, opts: &Value) -> Vec<u8> {
    let s = inner.parser.screen();
    let (rows, cols) = s.size();
    let want_rows = opts["rows"].as_u64().map(|r| r as u16).unwrap_or(rows).min(rows);
    let want_cols = opts["cols"].as_u64().map(|c| c as u16).unwrap_or(cols).min(cols);
    let from_top = opts["from"].as_str() == Some("top");
    let skip = if from_top { 0 } else { (rows - want_rows) as usize };
    let lines: Vec<String> = if opts["format"].as_str() == Some("ansi") {
        s.rows_formatted(0, want_cols).skip(skip).take(want_rows as usize).map(|r| String::from_utf8_lossy(&r).into_owned()).collect()
    } else {
        s.rows(0, want_cols).skip(skip).take(want_rows as usize).collect()
    };
    let (cy, cx) = s.cursor_position();
    frames::encode_json(frames::SCREEN, &json!({
        "seq": inner.screen_rev,
        "rows": want_rows,
        "cols": want_cols,
        "cursor": { "x": cx, "y": (cy as i64) - skip as i64 },
        "lines": lines,
    }))
}

/// #3158 — how long a hangup gets before the stop signal follows.
const HANGUP_GRACE: Duration = Duration::from_secs(1);

/// #3141 — `signal` to the command's process group, and to the command itself
/// should it have left the group.
fn signal_group(pid: u32, signal: i32) {
    unsafe {
        libc::kill(-(pid as i32), signal);
        libc::kill(pid as i32, signal);
    }
}
