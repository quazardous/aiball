//! #3066 — `attach.sock`: clients (tvty, a plain terminal, the web through the
//! daemon) per docs/LOOP-HOST.md. One reader thread per client; its writes go
//! through the client's own queue (session.rs).

use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};

use crate::frames;
use crate::session::{parse_size, Session};

pub const PROTOCOL_VERSION: u64 = 1;

pub fn serve(listener: UnixListener, session: Arc<Session>) {
    for conn in listener.incoming() {
        let Ok(sock) = conn else { continue };
        let session = session.clone();
        thread::spawn(move || handle(sock, session));
    }
}

fn refuse(sock: &mut UnixStream, code: &str, error: &str, extra: Value) {
    let mut body = json!({ "code": code, "error": error });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    let _ = frames::write_frame(sock, &frames::encode_json(frames::ERROR, &body));
}

fn handle(mut sock: UnixStream, session: Arc<Session>) {
    // The first frame is `hello`; anything else ends the connection.
    let hello: Value = match frames::read_frame(&mut sock) {
        Ok((frames::HELLO, payload)) => match serde_json::from_slice(&payload) {
            Ok(v) => v,
            Err(_) => return refuse(&mut sock, "BAD_HELLO", "hello is not JSON", json!({})),
        },
        _ => return,
    };
    if hello["version"].as_u64() != Some(PROTOCOL_VERSION) {
        return refuse(&mut sock, "VERSION_UNSUPPORTED", "this host speaks version 1", json!({ "versions": [PROTOCOL_VERSION] }));
    }
    // #3333 — a session whose command is over has nothing more to show: say so
    // at once, as its clients were told when it ended, instead of an attach
    // that waits for output that never comes.
    if session.is_over() {
        let _ = frames::write_frame(&mut sock, &frames::encode_json(frames::CLOSED, &json!({})));
        return;
    }
    let Ok(writer) = sock.try_clone() else { return };
    let client = session.attach(writer, &hello, std::process::id());
    loop {
        let (kind, payload) = match frames::read_frame(&mut sock) {
            Ok(f) => f,
            Err(_) => break,
        };
        match kind {
            frames::INPUT | frames::RESIZE | frames::FOCUS if !client.interactive => {
                let e = frames::encode_json(frames::ERROR, &json!({ "code": "READ_ONLY", "error": "a readonly client does not type or resize" }));
                client.send(e);
            }
            frames::INPUT => session.input(&client, &payload),
            frames::RESIZE => {
                if let Some(size) = serde_json::from_slice::<Value>(&payload).ok().and_then(|v| parse_size(&v)) {
                    session.client_resize(&client, size);
                }
            }
            frames::FOCUS => session.focus(&client),
            frames::HISTORY_REQUEST => {
                let v: Value = serde_json::from_slice(&payload).unwrap_or(json!({}));
                let before = v["before"].as_u64().unwrap_or(0) as usize;
                let count = v["count"].as_u64().unwrap_or(100).min(5000) as usize;
                client.send(frames::encode_json(frames::HISTORY, &session.history(before, count)));
            }
            // A frame type this host does not know is ignored (LOOP-HOST).
            _ => {}
        }
    }
    session.detach(&client);
}
