//! #3066 — `attach.sock`: clients (tvty, a plain terminal, the web through the
//! daemon) per docs/LOOP-HOST.md. One reader thread per client; its writes go
//! through the client's own queue (session.rs). #3425 — where the host has a
//! token (Windows, host/os.rs), a `hello` without it ends the connection
//! before anything is sent.

use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};

use crate::frames;
use crate::os::{self, Listener, Stream};
use crate::session::{parse_size, Session};

pub const PROTOCOL_VERSION: u64 = 1;

pub fn serve(listener: Listener, session: Arc<Session>, token: Option<String>) {
    let token: Arc<Option<String>> = Arc::new(token);
    for conn in listener.incoming() {
        let Ok(sock) = conn else { continue };
        os::no_delay(&sock);
        let (session, token) = (session.clone(), token.clone());
        thread::spawn(move || handle(sock, session, token.as_deref()));
    }
}

fn refuse(sock: &mut Stream, code: &str, error: &str, extra: Value) {
    let mut body = json!({ "code": code, "error": error });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    let _ = frames::write_frame(sock, &frames::encode_json(frames::ERROR, &body));
}

/// A `hello` a host with a token takes: the right token, said in it.
pub fn hello_admitted(hello: Option<&Value>, token: Option<&str>) -> bool {
    match token {
        None => true,
        Some(t) => os::token_matches(hello.and_then(|h| h["token"].as_str()), t),
    }
}

fn handle(mut sock: Stream, session: Arc<Session>, token: Option<&str>) {
    // The first frame is `hello`; anything else ends the connection.
    let hello: Option<Value> = match frames::read_frame(&mut sock) {
        Ok((frames::HELLO, payload)) => serde_json::from_slice(&payload).ok(),
        _ => return,
    };
    // A client without the token hears nothing, not even why.
    if !hello_admitted(hello.as_ref(), token) {
        return;
    }
    let Some(hello) = hello else {
        return refuse(&mut sock, "BAD_HELLO", "hello is not JSON", json!({}));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_a_token_every_hello_is_admitted() {
        assert!(hello_admitted(Some(&json!({ "version": 1 })), None));
        assert!(hello_admitted(None, None));
    }

    #[test]
    fn with_a_token_only_a_hello_that_says_it_is() {
        assert!(hello_admitted(Some(&json!({ "version": 1, "token": "t0k" })), Some("t0k")));
        assert!(!hello_admitted(Some(&json!({ "version": 1, "token": "bad" })), Some("t0k")));
        assert!(!hello_admitted(Some(&json!({ "version": 1 })), Some("t0k")));
        assert!(!hello_admitted(Some(&json!({ "version": 1, "token": 7 })), Some("t0k")));
        assert!(!hello_admitted(None, Some("t0k")));
    }
}
