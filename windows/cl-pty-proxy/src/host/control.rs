//! #3066 — `control.sock`: the daemon drives the session (docs/SESSION-HOST.md).
//! JSON-RPC 2.0, one message per line. Several controllers at once, the daemon
//! and the loop kernel: each gets its own answers, and every one hears the
//! notifications. A daemon that restarts simply connects again; its old
//! connection died with it.
//!
//! #3425 — where the host has a token (Windows, host/os.rs), a controller's
//! first line is `host.auth { token }`; any other first line, or a wrong
//! token, ends the connection unanswered, and a controller hears no
//! notification before it is in. Without a token, nothing changes on the wire.

use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::os::{self, Listener, Stream};
use crate::session::{parse_size, Session, StopSignal};

/// What the host does when asked to go away: its caller exits the process.
pub type Shutdown = Arc<dyn Fn() + Send + Sync>;

/// One controller's connection: its answers and the notifications share it.
type Conn = Arc<Mutex<Stream>>;

pub struct Control {
    session: Arc<Session>,
    controllers: Arc<Mutex<Vec<Conn>>>,
    shutdown: Shutdown,
    hello: Value,
    token: Option<String>,
}

/// #3425 — a controller's first line on a host with a token: `None` ends the
/// connection unanswered; `Some(reply)` lets it in, with the answer to send
/// when the call had an id.
fn auth_reply(first: &str, token: &str) -> Option<Option<Value>> {
    let req: Value = serde_json::from_str(first).ok()?;
    if req["method"].as_str() != Some("host.auth") || !os::token_matches(req["params"]["token"].as_str(), token) {
        return None;
    }
    Some(req.get("id").cloned().map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": {} })))
}

/// One line to one controller; false once its connection is gone.
fn send(conn: &Conn, v: &Value) -> bool {
    let mut text = v.to_string();
    text.push('\n');
    conn.lock().unwrap().write_all(text.as_bytes()).is_ok()
}

/// One line to every controller; one whose connection is gone is dropped.
fn broadcast(controllers: &Mutex<Vec<Conn>>, v: &Value) {
    controllers.lock().unwrap().retain(|c| send(c, v));
}

impl Control {
    pub fn new(session: Arc<Session>, hello: Value, shutdown: Shutdown, token: Option<String>) -> Arc<Self> {
        let controllers: Arc<Mutex<Vec<Conn>>> = Arc::new(Mutex::new(Vec::new()));
        let c = controllers.clone();
        session.set_notify(Some(Arc::new(move |method: &str, params: Value| {
            broadcast(&c, &json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        })));
        Arc::new(Control { session, controllers, shutdown, hello, token })
    }

    pub fn serve(self: Arc<Self>, listener: Listener) {
        for conn in listener.incoming() {
            let Ok(sock) = conn else { continue };
            os::no_delay(&sock);
            let Ok(writer) = sock.try_clone() else { continue };
            let conn: Conn = Arc::new(Mutex::new(writer));
            // With a token, a controller is in once its first line said it.
            if self.token.is_none() {
                self.controllers.lock().unwrap().push(conn.clone());
            }
            let me = self.clone();
            thread::spawn(move || me.read(sock, conn));
        }
    }

    fn read(&self, sock: Stream, conn: Conn) {
        let mut lines = BufReader::new(sock).lines();
        if let Some(token) = &self.token {
            let Some(Ok(first)) = lines.next() else { return };
            let Some(reply) = auth_reply(&first, token) else { return };
            if let Some(r) = reply {
                send(&conn, &r);
            }
            self.controllers.lock().unwrap().push(conn.clone());
        }
        for text in lines {
            let Ok(text) = text else { break };
            if text.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Value>(&text) {
                Ok(req) => self.call(&req),
                Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "not JSON" } })),
            };
            if let Some(r) = reply {
                send(&conn, &r);
            }
        }
        self.controllers.lock().unwrap().retain(|c| !Arc::ptr_eq(c, &conn));
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
                    Some("INT") => StopSignal::Int,
                    _ => StopSignal::Term,
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
            // #3425 — a host with a token checked it on the first line; later, and
            // on a host without one, there is nothing to check.
            "host.auth" => Ok(json!({})),
            "host.shutdown" => {
                s.stop(StopSignal::Term, Duration::from_secs(10), false);
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
            if rev != sent && last_ctrl.elapsed() >= every && !self.controllers.lock().unwrap().is_empty() {
                broadcast(&self.controllers, &json!({ "jsonrpc": "2.0", "method": "host.screen_changed", "params": self.session.screen() }));
                sent = rev;
                last_ctrl = std::time::Instant::now();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_line_must_be_host_auth_with_the_token() {
        let ok = auth_reply(r#"{"jsonrpc":"2.0","id":1,"method":"host.auth","params":{"token":"t0k"}}"#, "t0k");
        assert_eq!(ok, Some(Some(json!({ "jsonrpc": "2.0", "id": 1, "result": {} }))));
        // A notification lets the controller in, with nothing to answer.
        let note = auth_reply(r#"{"jsonrpc":"2.0","method":"host.auth","params":{"token":"t0k"}}"#, "t0k");
        assert_eq!(note, Some(None));
        for bad in [
            r#"{"jsonrpc":"2.0","id":1,"method":"host.auth","params":{"token":"bad"}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"host.auth","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"host.hello","params":{"token":"t0k"}}"#,
            "not json",
            "",
        ] {
            assert_eq!(auth_reply(bad, "t0k"), None, "{bad}");
        }
    }
}
