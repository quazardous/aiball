//! #3066 — the session host, run as the daemon runs it, spoken to as a client
//! (docs/LOOP-HOST.md) and as the controller (docs/SESSION-HOST.md) would.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const HELLO: u8 = 1;
const WELCOME: u8 = 2;
const SNAPSHOT: u8 = 3;
const OUTPUT: u8 = 4;
const INPUT: u8 = 5;
const RESIZE: u8 = 6;
const SIZE: u8 = 8;
const SCREEN: u8 = 9;
const EXITED: u8 = 0x0a;
const CLOSED: u8 = 0x0b;
const ERROR: u8 = 0x0c;
const HISTORY_REQUEST: u8 = 0x0d;
const HISTORY: u8 = 0x0e;

struct Host {
    child: Child,
    dir: PathBuf,
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start(name: &str, argv: &[&str]) -> Host {
    let dir = std::env::temp_dir().join(format!("cl-session-host-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_cl-session-host"));
    cmd.args(["--dir", dir.to_str().unwrap(), "--agent", name, "--rows", "10", "--cols", "40", "--"]).args(argv);
    let child = cmd.spawn().expect("spawn the host");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !dir.join("host.json").exists() {
        assert!(Instant::now() < deadline, "host.json never appeared");
        std::thread::sleep(Duration::from_millis(20));
    }
    Host { child, dir }
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = vec![kind];
    f.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    f.extend_from_slice(payload);
    f
}

fn read_frame(s: &mut UnixStream) -> (u8, Vec<u8>) {
    let mut head = [0u8; 5];
    s.read_exact(&mut head).expect("a frame");
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    let mut p = vec![0u8; len];
    s.read_exact(&mut p).unwrap();
    (head[0], p)
}

fn json_of(p: &[u8]) -> Value {
    serde_json::from_slice(p).unwrap()
}

fn seq_of(p: &[u8]) -> (u64, String) {
    (u64::from_be_bytes(p[..8].try_into().unwrap()), String::from_utf8_lossy(&p[8..]).into_owned())
}

fn attach(dir: &Path, hello: Value) -> UnixStream {
    let mut s = UnixStream::connect(dir.join("attach.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(&frame(HELLO, hello.to_string().as_bytes())).unwrap();
    s
}

/// Frames until one of `kind` arrives; the others are returned too, in order.
fn until(s: &mut UnixStream, kind: u8) -> Vec<(u8, Vec<u8>)> {
    let mut out = Vec::new();
    loop {
        let f = read_frame(s);
        let done = f.0 == kind;
        out.push(f);
        if done {
            return out;
        }
    }
}

struct Ctl {
    r: BufReader<UnixStream>,
    w: UnixStream,
    next: u64,
    notes: Vec<Value>,
}

impl Ctl {
    fn open(dir: &Path) -> Ctl {
        let w = UnixStream::connect(dir.join("control.sock")).unwrap();
        w.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        Ctl { r: BufReader::new(w.try_clone().unwrap()), w, next: 1, notes: Vec::new() }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let mut line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        line.push('\n');
        self.w.write_all(line.as_bytes()).unwrap();
        loop {
            let m = self.line();
            if m["id"] == json!(id) {
                return m;
            }
            self.notes.push(m);
        }
    }

    fn line(&mut self) -> Value {
        let mut l = String::new();
        self.r.read_line(&mut l).expect("a line from the host");
        serde_json::from_str(&l).unwrap()
    }

    fn note(&mut self, method: &str) -> Value {
        if let Some(i) = self.notes.iter().position(|n| n["method"] == method) {
            return self.notes.remove(i);
        }
        loop {
            let m = self.line();
            if m["method"] == method {
                return m;
            }
            self.notes.push(m);
        }
    }
}

#[test]
fn files_and_hello() {
    let h = start("files", &["sh", "-c", "printf ready; sleep 30"]);
    let info: Value = serde_json::from_str(&std::fs::read_to_string(h.dir.join("host.json")).unwrap()).unwrap();
    assert_eq!(info["agent"], "files");
    for f in ["attach.sock", "control.sock"] {
        let mode = std::fs::metadata(h.dir.join(f)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{f} is the user's only");
    }
    let mut c = Ctl::open(&h.dir);
    let hello = c.call("host.hello", json!({}))["result"].clone();
    assert_eq!(hello["claude"]["running"], true);
    assert_eq!(hello["size"], json!({ "rows": 10, "cols": 40 }));
}

#[test]
fn a_stream_client_gets_welcome_snapshot_then_output_in_seq_order() {
    let h = start("stream", &["sh", "-c", "printf hello; cat"]);
    std::thread::sleep(Duration::from_millis(300));
    let mut s = attach(&h.dir, json!({ "version": 1, "client": "test", "mode": "interactive", "view": "stream", "size": { "rows": 10, "cols": 40 } }));
    let (k, w) = read_frame(&mut s);
    assert_eq!(k, WELCOME);
    assert_eq!(json_of(&w)["consumer"], "stream");
    let (k, snap) = read_frame(&mut s);
    assert_eq!(k, SNAPSHOT);
    let (seq, bytes) = seq_of(&snap);
    assert_eq!(seq, 5, "the snapshot reflects the 5 bytes written so far");
    assert!(bytes.contains("hello"));
    s.write_all(&frame(INPUT, b"abc\r")).unwrap();
    let frames = until(&mut s, OUTPUT);
    let (next, echoed) = seq_of(&frames.last().unwrap().1);
    assert!(echoed.contains("abc"), "cat echoes through the PTY");
    assert_eq!(next, seq + echoed.len() as u64, "output continues exactly where the snapshot ended");
}

#[test]
fn the_controller_injects_reads_the_screen_and_hears_it_change() {
    let h = start("control", &["cat"]);
    let mut c = Ctl::open(&h.dir);
    assert!(c.call("host.inject", json!({ "text": "wake up\r" }))["result"].is_object());
    let changed = c.note("host.screen_changed");
    assert!(changed["params"]["text"].as_str().unwrap().contains("wake up"));
    let screen = c.call("host.screen", json!({}))["result"].clone();
    assert!(screen["text"].as_str().unwrap().contains("wake up"));
    assert_eq!((screen["rows"].as_u64(), screen["cols"].as_u64()), (Some(10), Some(40)));
}

#[test]
fn a_readonly_client_may_not_type_and_a_preview_gets_screen_frames() {
    let h = start("readonly", &["sh", "-c", "printf preview; cat"]);
    std::thread::sleep(Duration::from_millis(300));
    let mut ro = attach(&h.dir, json!({ "version": 1, "mode": "readonly", "view": "screen", "screen": { "rows": 3, "from": "top" } }));
    until(&mut ro, WELCOME);
    let (k, p) = read_frame(&mut ro);
    assert_eq!(k, SCREEN);
    let v = json_of(&p);
    assert_eq!(v["lines"].as_array().unwrap().len(), 3);
    assert!(v["lines"][0].as_str().unwrap().contains("preview"));
    ro.write_all(&frame(INPUT, b"x")).unwrap();
    let got = until(&mut ro, ERROR);
    assert_eq!(json_of(&got.last().unwrap().1)["code"], "READ_ONLY");
}

#[test]
fn the_size_follows_the_interactive_client_that_typed_last() {
    let h = start("size", &["cat"]);
    let mut a = attach(&h.dir, json!({ "version": 1, "mode": "interactive", "size": { "rows": 20, "cols": 60 } }));
    let got = until(&mut a, SIZE);
    assert_eq!(json_of(&got.last().unwrap().1), json!({ "rows": 20, "cols": 60 }), "the first interactive client takes its size");
    let mut b = attach(&h.dir, json!({ "version": 1, "mode": "interactive", "size": { "rows": 30, "cols": 90 } }));
    until(&mut b, SNAPSHOT);
    b.write_all(&frame(INPUT, b"k")).unwrap();
    let got = until(&mut a, SIZE);
    assert_eq!(json_of(&got.last().unwrap().1), json!({ "rows": 30, "cols": 90 }), "typing takes the size");
    b.write_all(&frame(RESIZE, json!({ "rows": 25, "cols": 70 }).to_string().as_bytes())).unwrap();
    let got = until(&mut a, SIZE);
    assert_eq!(json_of(&got.last().unwrap().1), json!({ "rows": 25, "cols": 70 }));
    // A mouse report types nothing: the size stays with b.
    a.write_all(&frame(INPUT, b"\x1b[<0;1;1M")).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let mut c = Ctl::open(&h.dir);
    assert_eq!(c.call("host.hello", json!({}))["result"]["size"], json!({ "rows": 25, "cols": 70 }));
}

#[test]
fn a_restart_keeps_clients_and_a_real_exit_closes_them() {
    let h = start("restart", &["cat"]);
    let mut s = attach(&h.dir, json!({ "version": 1, "mode": "readonly" }));
    until(&mut s, SNAPSHOT);
    let mut c = Ctl::open(&h.dir);
    c.call("host.stop", json!({ "restart": true, "timeout_ms": 3000 }));
    let got = until(&mut s, EXITED);
    assert_eq!(json_of(&got.last().unwrap().1)["restarting"], true);
    let started = c.call("host.start", json!({ "argv": ["sh", "-c", "printf again; exit 3"] }));
    assert!(started["result"]["pid"].as_u64().unwrap() > 0);
    let got = until(&mut s, EXITED);
    assert!(got.iter().any(|(k, _)| *k == SNAPSHOT), "a fresh snapshot after the restart");
    assert_eq!(json_of(&got.last().unwrap().1), json!({ "code": 3, "restarting": false }));
    let (k, _) = read_frame(&mut s);
    assert_eq!(k, CLOSED, "the session is over for its clients");
    let first = c.note("host.exited");
    assert_eq!(first["params"]["restarting"], true, "the stop for a restart");
    let last = c.note("host.exited");
    assert_eq!((last["params"]["code"].as_i64(), last["params"]["restarting"].as_bool()), (Some(3), Some(false)));
}

#[test]
fn history_and_a_version_the_host_does_not_speak() {
    let h = start("history", &["sh", "-c", "for i in $(seq 1 50); do echo line$i; done; cat"]);
    std::thread::sleep(Duration::from_millis(400));
    let mut s = attach(&h.dir, json!({ "version": 1, "mode": "readonly" }));
    let welcome = json_of(&until(&mut s, WELCOME).last().unwrap().1);
    let kept = welcome["history_lines"].as_u64().unwrap();
    assert!(kept >= 40, "the lines that scrolled off are kept");
    until(&mut s, SNAPSHOT);
    s.write_all(&frame(HISTORY_REQUEST, json!({ "before": kept, "count": 3 }).to_string().as_bytes())).unwrap();
    let hist = json_of(&until(&mut s, HISTORY).last().unwrap().1);
    assert_eq!(hist["first"].as_u64(), Some(kept - 3));
    assert_eq!(hist["lines"].as_array().unwrap().len(), 3);
    let mut v2 = attach(&h.dir, json!({ "version": 2 }));
    let (k, p) = read_frame(&mut v2);
    assert_eq!(k, ERROR);
    assert_eq!(json_of(&p)["code"], "VERSION_UNSUPPORTED");
}

#[test]
fn shutdown_stops_the_command_and_removes_the_files() {
    let mut h = start("shutdown", &["cat"]);
    let mut c = Ctl::open(&h.dir);
    c.call("host.shutdown", json!({}));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(Some(_)) = h.child.try_wait() {
            break;
        }
        assert!(Instant::now() < deadline, "the host did not exit");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!h.dir.join("host.json").exists());
    assert!(!h.dir.join("attach.sock").exists());
}
