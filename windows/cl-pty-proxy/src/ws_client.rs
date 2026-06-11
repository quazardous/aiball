#![allow(dead_code)] // wired into main.rs incrementally (Phase 1).
//! #768 — unified Rust proxy: ws client of `loop.sock` (Phase 1, Windows
//! loopback transport #739). Mirrors the thin `pty-proxy.py` contract
//! (post-#924):
//!   - emits `{kind:"proxyEvent", data:{...}}` frames (afk_key / typing /
//!     marker) — replaces the old marker FILE writes ;
//!   - receives `{kind:"inject", data:{text}}` → writes `text` to the PTY ;
//!   - receives `{kind:"view", data:{...}}` → caches it (NO painting — the TS
//!     `BarRenderer` #633 owns the bar on both platforms).
//!
//! One thread owns the connection. A read timeout interleaves: drain outbound
//! proxyEvents → read one inbound frame → flush queued pongs. tungstenite
//! auto-pongs the server's heartbeat pings (#769) on read+flush. Best-effort:
//! reconnects on a fixed 1s backoff, re-resolving `loop.sock.addr` each attempt
//! so a server rebind (new port+token) is absorbed transparently.

use std::fs;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::Message;

const RECONNECT_MS: u64 = 1_000;
const READ_TIMEOUT_MS: u64 = 250;
/// The server pings every 15s (#769). No frame/ping for this long ⇒ the
/// connection is silently dead (NIC hiccup / suspend) ⇒ force a reconnect.
const WATCHDOG_MS: u128 = 30_000;

/// Inbound callbacks invoked from the ws thread. `on_inject` writes wake text
/// to the PTY master ; `on_view` caches the pushed view (no paint).
pub struct Callbacks {
    pub on_inject: Box<dyn Fn(&str) + Send>,
    pub on_view: Box<dyn Fn(&Value) + Send>,
}

/// Handle other threads use to emit `proxyEvent`s. Clone freely.
#[derive(Clone)]
pub struct WsHandle {
    tx: Sender<Value>,
}

impl WsHandle {
    /// Best-effort fire-and-forget. `data` is the `proxyEvent` payload, e.g.
    /// `json!({"event":"keystroke","kind":"afk_key","now_ms":...})`. Dropped
    /// silently when the socket is down — the next (re)connect re-syncs state.
    pub fn emit(&self, data: Value) {
        let _ = self.tx.send(data);
    }
}

/// Convenience: emit a `keystroke` proxyEvent (`afk_key` toggles, `typing`
/// arms NOT-AFK 10m — the TS state machine interprets).
pub fn keystroke(kind: &str, now_ms: u128) -> Value {
    json!({ "event": "keystroke", "kind": kind, "now_ms": now_ms })
}

/// Convenience: emit a `marker` proxyEvent (e.g. `touch_marker`).
pub fn marker(name: &str, now_ms: u128) -> Value {
    json!({ "event": "marker", "name": name, "now_ms": now_ms })
}

/// Spawn the ws-client thread. `sock_path` is the `loop.sock` path; the address
/// marker is `<sock_path>.addr` (`{port, token}`, written by win32Transport).
pub fn start(sock_path: String, cb: Callbacks) -> WsHandle {
    let (tx, rx) = channel::<Value>();
    thread::spawn(move || run(sock_path, rx, cb));
    WsHandle { tx }
}

/// Resolve `<sock_path>.addr` → (port, ws-url). None when the marker is
/// missing/unreadable (server not up yet) — caller retries on backoff.
fn resolve(sock_path: &str) -> Option<(u16, String)> {
    let raw = fs::read_to_string(format!("{sock_path}.addr")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let token = v.get("token")?.as_str()?;
    if port == 0 || token.is_empty() {
        return None;
    }
    // token is base64url (no chars needing percent-encoding in a query value).
    Some((port, format!("ws://127.0.0.1:{port}/?t={token}")))
}

fn dispatch(text: &str, cb: &Callbacks) {
    let frame: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return, // drop malformed
    };
    match frame.get("kind").and_then(Value::as_str) {
        Some("view") => {
            if let Some(data) = frame.get("data") {
                if data.is_object() {
                    (cb.on_view)(data);
                }
            }
        }
        Some("inject") => {
            if let Some(t) = frame
                .get("data")
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)
            {
                (cb.on_inject)(t);
            }
        }
        _ => {} // unknown kind dropped (forward-compat)
    }
}

fn run(sock_path: String, rx: Receiver<Value>, cb: Callbacks) {
    loop {
        let (port, url) = match resolve(&sock_path) {
            Some(x) => x,
            None => {
                thread::sleep(Duration::from_millis(RECONNECT_MS));
                continue;
            }
        };
        let stream = match TcpStream::connect(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(_) => {
                thread::sleep(Duration::from_millis(RECONNECT_MS));
                continue;
            }
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(READ_TIMEOUT_MS)));
        let mut ws = match tungstenite::client(url.as_str(), stream) {
            Ok((ws, _resp)) => ws,
            Err(_) => {
                thread::sleep(Duration::from_millis(RECONNECT_MS));
                continue;
            }
        };

        let mut last_activity = Instant::now();
        'session: loop {
            // 1. Drain outbound proxyEvents queued by other threads.
            loop {
                match rx.try_recv() {
                    Ok(data) => {
                        let frame = json!({ "kind": "proxyEvent", "data": data }).to_string();
                        if ws.send(Message::Text(frame)).is_err() {
                            break 'session;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return, // all handles dropped
                }
            }
            // 2. Read one inbound frame (the read timeout bounds the block).
            match ws.read() {
                Ok(Message::Text(t)) => {
                    last_activity = Instant::now();
                    dispatch(&t, &cb);
                }
                Ok(Message::Binary(b)) => {
                    last_activity = Instant::now();
                    if let Ok(t) = String::from_utf8(b) {
                        dispatch(&t, &cb);
                    }
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                    // tungstenite queued the Pong reply ; the flush below sends it.
                    last_activity = Instant::now();
                }
                Ok(Message::Close(_)) => break 'session,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    // Read timeout — no frame this tick. Fall through to flush + watchdog.
                }
                Err(_) => break 'session,
            }
            // 3. Flush queued pongs (and any partially-buffered outbound).
            let _ = ws.flush();
            // 4. Watchdog: server heartbeat silence ⇒ dead connection.
            if last_activity.elapsed().as_millis() > WATCHDOG_MS {
                break 'session;
            }
        }
        let _ = ws.close(None);
        thread::sleep(Duration::from_millis(RECONNECT_MS));
    }
}
