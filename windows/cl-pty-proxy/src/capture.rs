//! #3057 — the proxy's side of a session capture (`CL_CAPTURE=1`): one NDJSON
//! line per keystroke, with what it was, what was forwarded and what the
//! Decider made of it, and one per injection. Written to
//! `<state_dir>/capture/proxy.ndjson`, on the same epoch clock (`t`, seconds)
//! as the kernel's `panes.ndjson`, so `bin/cl-capture` merges the two into one
//! timeline.
//!
//! Best-effort and observation-only: a write that fails is dropped, and
//! nothing here changes what the proxy forwards.

use std::fs::{create_dir_all, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::core::{Marker, Verdict, Word};

#[derive(Clone)]
pub struct Capture {
    file: Arc<Mutex<File>>,
}

impl Capture {
    /// The capture file when `CL_CAPTURE=1` and the loop's state dir is known; None otherwise.
    pub fn from_env() -> Option<Self> {
        if std::env::var("CL_CAPTURE").as_deref() != Ok("1") {
            return None;
        }
        let sd = std::env::var("CL_STATE_DIR").ok().filter(|s| !s.is_empty())?;
        Self::open(PathBuf::from(sd).join("capture").join("proxy.ndjson"))
    }

    pub fn open(path: PathBuf) -> Option<Self> {
        if let Some(dir) = path.parent() {
            create_dir_all(dir).ok()?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path).ok()?;
        Some(Capture { file: Arc::new(Mutex::new(file)) })
    }

    pub fn write(&self, line: &Value) {
        if let Ok(mut f) = self.file.lock() {
            let _ = writeln!(f, "{line}");
        }
    }
}

pub fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn marker_name(m: &Marker) -> &'static str {
    match m {
        Marker::SetAfk => "set_afk",
        Marker::ClearAfk => "clear_afk",
        Marker::TouchTyping => "touch_typing",
        Marker::TouchUserGrace => "touch_user_grace",
        Marker::ClearUserGrace => "clear_user_grace",
    }
}

/// One keystroke: its raw bytes, what was forwarded (empty = swallowed), and the verdict.
pub fn key_line(t: f64, raw: &[u8], v: &Verdict) -> Value {
    json!({
        "t": t,
        "event": "key",
        "raw": hex(raw),
        "forward": hex(&v.forward),
        "swallowed": v.forward.is_empty() && !raw.is_empty(),
        "typing": v.typing,
        "lone_esc": v.lone_esc,
        "afk_fired": v.afk_fired,
        "reload_fired": v.reload_fired,
        "afk_active": v.afk_active,
        "word": match v.word { Word::Stop => Value::from("stop"), Word::Rest => Value::from("rest"), Word::None => Value::Null },
        "markers": v.markers.iter().map(marker_name).collect::<Vec<_>>(),
    })
}

/// One injection from the kernel (a wake): what was written to claude.
pub fn inject_line(t: f64, text: &str) -> Value {
    json!({ "t": t, "event": "inject", "forward": hex(text.as_bytes()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict() -> Verdict {
        Verdict {
            forward: b"a".to_vec(),
            markers: vec![Marker::TouchTyping],
            word: Word::Stop,
            afk_fired: false,
            typing: true,
            lone_esc: false,
            reload_fired: false,
            afk_active: false,
        }
    }

    #[test]
    fn a_keystroke_line_says_what_it_was_and_what_was_decided() {
        let l = key_line(12.5, b"a", &verdict());
        assert_eq!(l["t"], json!(12.5));
        assert_eq!(l["event"], json!("key"));
        assert_eq!((l["raw"].as_str(), l["forward"].as_str()), (Some("61"), Some("61")));
        assert_eq!((l["typing"].as_bool(), l["swallowed"].as_bool()), (Some(true), Some(false)));
        assert_eq!(l["word"], json!("stop"));
        assert_eq!(l["markers"], json!(["touch_typing"]));
    }

    #[test]
    fn a_swallowed_key_forwards_nothing() {
        let mut v = verdict();
        v.forward.clear();
        v.afk_fired = true;
        let l = key_line(1.0, &[0x1b, 0x1b], &v);
        assert_eq!((l["forward"].as_str(), l["swallowed"].as_bool(), l["afk_fired"].as_bool()), (Some(""), Some(true), Some(true)));
    }

    #[test]
    fn an_injection_line_is_the_one_cl_capture_reads_as_inject() {
        let l = inject_line(3.0, "wake\r");
        assert_eq!((l["event"].as_str(), l["forward"].as_str()), (Some("inject"), Some("77616b650d")));
    }

    #[test]
    fn lines_are_appended_as_ndjson() {
        let dir = std::env::temp_dir().join(format!("cl-capture-test-{}", std::process::id()));
        let path = dir.join("capture").join("proxy.ndjson");
        let c = Capture::open(path.clone()).unwrap();
        c.write(&inject_line(1.0, "a"));
        c.write(&inject_line(2.0, "b"));
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["t"], json!(2.0));
        let _ = std::fs::remove_dir_all(dir);
    }
}
