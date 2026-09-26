//! #3066 — `control.sock`: the daemon drives the session (docs/SESSION-HOST.md).
//! JSON-RPC 2.0, one message per line. One controller at a time: a new
//! connection replaces the old one (the daemon restarted).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::session::{parse_size, Session};

/// What the host does when asked to go away: its caller exits the process.
pub type Shutdown = Arc<dyn Fn() + Send + Sync>;

pub struct Control {
    session: Arc<Session>,
    /// The controller's connection, shared by the answers and the notifications.
    out: Arc<Mutex<Option<UnixStream>>>,
    shutdown: Shutdown,
    hello: Value,
}

fn line(out: &Mutex<Option<UnixStream>>, v: &Value) {
    let mut guard = out.lock().unwrap();
    if let Some(s) = guard.as_mut() {
        let mut text = v.to_string();
        text.push('\n');
        if s.write_all(text.as_bytes()).is_err() {
            *guard = None;
        }
    }
}

impl Control {
    pub fn new(session: Arc<Session>, hello: Value, shutdown: Shutdown) -> Arc<Self> {
        let out: Arc<Mutex<Option<UnixStream>>> = Arc::new(Mutex::new(None));
        let o = out.clone();
        session.set_notify(Some(Arc::new(move |method: &str, params: Value| {
            line(&o, &json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        })));
        Arc::new(Control { session, out, shutdown, hello })
    }

    pub fn serve(self: Arc<Self>, listener: UnixListener) {
        for conn in listener.incoming() {
            let Ok(sock) = conn else { continue };
            let Ok(writer) = sock.try_clone() else { continue };
            // A new controller replaces the old one.
            if let Some(old) = self.out.lock().unwrap().replace(writer) {
                let _ = old.shutdown(std::net::Shutdown::Both);
            }
            let me = self.clone();
            thread::spawn(move || me.read(sock));
        }
    }

    fn read(&self, sock: UnixStream) {
        for text in BufReader::new(sock).lines() {
            let Ok(text) = text else { break };
            if text.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Value>(&text) {
                Ok(req) => self.call(&req),
                Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "not JSON" } })),
            };
            if let Some(r) = reply {
                line(&self.out, &r);
            }
        }
    }

    /// One call; None for a notification (no id).
    fn call(&self, req: &Value) -> Option<Value> {
        let id = req.get("id").cloned();
        let method = req["method"].as_str().unwrap_or("");
        let p = &req["params"];
        let result = self.dispatch(method, p);
        let id = id?;
        Some(match result {
            Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        })
    }

    fn dispatch(&self, method: &str, p: &Value) -> Result<Value, (i64, String)> {
        let s = &self.session;
        match method {
            "host.hello" => {
                let mut v = self.hello.clone();
                v["claude"] = s.claude();
                let (rows, cols) = s.size();
                v["size"] = json!({ "rows": rows, "cols": cols });
                v["clients"] = json!(s.client_count());
                Ok(v)
            }
            "host.inject" => {
                let text = p["text"].as_str().ok_or((-32602, "text required".to_string()))?;
                s.inject(text).map(|_| json!({})).map_err(|e| (409, e))
            }
            "host.screen" => Ok(s.screen()),
            "host.start" => {
                let argv: Vec<String> = p["argv"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                let env: Vec<(String, String)> = p["env"].as_object()
                    .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
                    .unwrap_or_default();
                s.start(&argv, &env, p["cwd"].as_str()).map(|pid| json!({ "pid": pid })).map_err(|e| (409, e))
            }
            "host.stop" => {
                let signal = match p["signal"].as_str() {
                    Some("INT") => libc::SIGINT,
                    _ => libc::SIGTERM,
                };
                let timeout = Duration::from_millis(p["timeout_ms"].as_u64().unwrap_or(10_000));
                let restart = p["restart"].as_bool().unwrap_or(false);
                Ok(json!({ "exit_code": s.stop(signal, timeout, restart) }))
            }
            "host.resize" => {
                let size = parse_size(p).ok_or((-32602, "rows and cols required".to_string()))?;
                if s.control_resize(size) {
                    Ok(json!({}))
                } else {
                    Err((409, "an interactive client owns the size".into()))
                }
            }
            "host.shutdown" => {
                s.stop(libc::SIGTERM, Duration::from_secs(10), false);
                s.close_all();
                let shutdown = self.shutdown.clone();
                // After the answer has gone out.
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(100));
                    shutdown();
                });
                Ok(json!({}))
            }
            _ => Err((-32601, format!("no method {method}"))),
        }
    }

    /// The screen changed: tell the controller, at most every `every`.
    pub fn watch_screen(self: Arc<Self>, every: Duration, previews_every: Duration) {
        let mut sent = u64::MAX;
        let mut previews = u64::MAX;
        let mut last_ctrl = std::time::Instant::now() - every;
        loop {
            thread::sleep(previews_every);
            let rev = self.session.screen_rev();
            if rev != previews {
                self.session.push_previews(previews);
                previews = rev;
            }
            if rev != sent && last_ctrl.elapsed() >= every && self.out.lock().unwrap().is_some() {
                line(&self.out, &json!({ "jsonrpc": "2.0", "method": "host.screen_changed", "params": self.session.screen() }));
                sent = rev;
                last_ctrl = std::time::Instant::now();
            }
        }
    }
}
