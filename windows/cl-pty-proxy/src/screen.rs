//! #3048 — a model of the screen claude draws, kept by the proxy from the
//! bytes it already forwards: the text, the cursor, the geometry. It answers
//! `getScreen` on `loop.sock`, so the kernel can read the screen without
//! `tmux capture-pane` — once the two are proven to agree, which is what the
//! kernel measures first (an indicator: nothing reads the screen from here yet).
//!
//! Visual rows, like `capture-pane -p`: a line claude wrapped is two rows here
//! too. No scrollback: the visible screen only.
//!
//! Opt-in (`CL_SCREEN_MODEL=1`): the release build aborts on panic, so a
//! parser panic would end the session despite the guard in `feed`, which
//! only helps an unwinding build.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

#[derive(Clone)]
pub struct Screen {
    parser: Arc<Mutex<vt100::Parser>>,
    /// Set if the parser ever panicked: the model is dropped, never the
    /// forwarding. `feed` runs on the thread that copies claude's output to
    /// the terminal, and an indicator must not be able to freeze the pane.
    broken: Arc<AtomicBool>,
}

impl Screen {
    pub fn new(rows: u16, cols: u16) -> Self {
        Screen {
            parser: Arc::new(Mutex::new(vt100::Parser::new(rows.max(1), cols.max(1), 0))),
            broken: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Everything claude wrote to its terminal, in order.
    pub fn feed(&self, bytes: &[u8]) {
        if self.broken.load(Ordering::Relaxed) {
            return;
        }
        let ok = catch_unwind(AssertUnwindSafe(|| {
            if let Ok(mut p) = self.parser.lock() {
                p.process(bytes);
            }
        }));
        if ok.is_err() {
            self.broken.store(true, Ordering::Relaxed);
        }
    }

    /// The terminal was resized: so is the model, like claude's PTY.
    pub fn resize(&self, rows: u16, cols: u16) {
        if let Ok(mut p) = self.parser.lock() {
            p.screen_mut().set_size(rows.max(1), cols.max(1));
        }
    }

    /// The visible screen: one string per row, joined by `\n`; the cursor as
    /// 0-based `{x: column, y: row}`, like tmux's `#{cursor_x}` / `#{cursor_y}`.
    /// None once the model is broken: the kernel then skips its comparison.
    pub fn snapshot(&self) -> Option<Value> {
        if self.broken.load(Ordering::Relaxed) {
            return None;
        }
        let p = match self.parser.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        let s = p.screen();
        let (rows, cols) = s.size();
        let text = s.rows(0, cols).collect::<Vec<_>>().join("\n");
        let (cy, cx) = s.cursor_position();
        Some(json!({ "text": text, "cursor": { "x": cx, "y": cy }, "rows": rows, "cols": cols }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &Screen) -> String {
        s.snapshot().unwrap()["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn plain_text_and_cursor() {
        let s = Screen::new(4, 20);
        s.feed(b"hello\r\nworld");
        let snap = s.snapshot().unwrap();
        assert_eq!(text(&s).lines().take(2).collect::<Vec<_>>(), vec!["hello", "world"]);
        assert_eq!(snap["cursor"], json!({ "x": 5, "y": 1 }));
        assert_eq!((snap["rows"].as_u64(), snap["cols"].as_u64()), (Some(4), Some(20)));
    }

    #[test]
    fn colours_do_not_reach_the_text() {
        let s = Screen::new(2, 20);
        s.feed(b"\x1b[1;31mred\x1b[0m plain");
        assert_eq!(text(&s).lines().next(), Some("red plain"));
    }

    #[test]
    fn a_long_line_wraps_into_visual_rows_like_capture_pane() {
        let s = Screen::new(3, 5);
        s.feed(b"abcdefgh");
        assert_eq!(text(&s).lines().take(2).collect::<Vec<_>>(), vec!["abcde", "fgh"]);
    }

    #[test]
    fn the_alternate_screen_is_what_shows_and_leaving_it_restores() {
        let s = Screen::new(2, 10);
        s.feed(b"main");
        s.feed(b"\x1b[?1049h\x1b[Halt");
        assert_eq!(text(&s).lines().next(), Some("alt"));
        s.feed(b"\x1b[?1049l");
        assert_eq!(text(&s).lines().next(), Some("main"));
    }

    #[test]
    fn a_wide_character_takes_two_columns() {
        let s = Screen::new(2, 10);
        s.feed("日本x".as_bytes());
        assert_eq!(text(&s).lines().next(), Some("日本x"));
        assert_eq!(s.snapshot().unwrap()["cursor"]["x"], json!(5));
    }

    #[test]
    fn clearing_the_screen_clears_the_model() {
        let s = Screen::new(2, 10);
        s.feed(b"old\x1b[2J\x1b[Hnew");
        assert_eq!(text(&s).lines().next(), Some("new"));
    }

    #[test]
    fn a_parser_that_panics_drops_the_model_not_the_caller() {
        let s = Screen::new(2, 10);
        // Poison the parser the way a panic inside `process` would.
        let p = s.parser.clone();
        let _ = std::thread::spawn(move || {
            let _guard = p.lock().unwrap();
            panic!("boom");
        })
        .join();
        s.feed(b"after");
        assert!(s.snapshot().is_some(), "a poisoned lock alone does not break the model");
        let s2 = Screen::new(2, 10);
        s2.broken.store(true, Ordering::Relaxed);
        s2.feed(b"ignored");
        assert!(s2.snapshot().is_none(), "a broken model answers nothing");
    }

    #[test]
    fn a_resize_follows_the_terminal() {
        let s = Screen::new(2, 10);
        s.resize(5, 40);
        assert_eq!((s.snapshot().unwrap()["rows"].as_u64(), s.snapshot().unwrap()["cols"].as_u64()), (Some(5), Some(40)));
    }
}
