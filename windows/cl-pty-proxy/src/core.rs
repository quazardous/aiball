//! Pure decision core for the Windows ConPTY proxy — the Rust mirror of the
//! Python proxy's `_Decider` + `split_keystrokes` + `_AfkDetector`
//! (`src/claude-loop/pty-proxy.py`, #360/#381). NO I/O here: everything is
//! pure so it unit-tests without a PTY (`cargo test`), exactly like the
//! Python side is tested via `--replay`.
//!
//! The one Windows-specific twist: under psmux/ConPTY, keystrokes arrive as
//! **win32-input-mode** sequences (`ESC[Vk;Sc;Uc;Kd;Cs;Rc_`), not raw VT. So
//! `split_units` parses those into discrete key events and decodes each to the
//! **VT byte form** the key would emit (`win32_to_vt`) — the same byte
//! representation the AFK combos use (from the TS `parseAfkKey`, shared via
//! `CL_AFK_SPEC`). Classification (typing / lone-ESC / combo match) runs on
//! that decoded VT; the bytes actually forwarded to claude stay the original
//! win32 sequence (passthrough), so claude's own ConPTY decodes them.

/// A side effect the live loop must perform (the Decider only NAMES them).
/// Order within a verdict is significant — mirrors the Python marker order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Marker {
    SetAfk,
    ClearAfk,
    TouchTyping,
    TouchUserGrace,
    ClearUserGrace,
}

/// Bar-word intent. `Rest` resolves to wait/loop from the grace windows at
/// apply time (contextual), so the Decider stays pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Word {
    Stop,
    Rest,
    None,
}

/// Outcome of feeding one keystroke to the Decider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// Bytes to write to claude NOW (raw win32 passthrough; empty = swallowed).
    pub forward: Vec<u8>,
    pub markers: Vec<Marker>,
    pub word: Word,
    pub afk_fired: bool,
    pub typing: bool,
    pub lone_esc: bool,
    /// AFK logical state AFTER this keystroke (away = true).
    pub afk_active: bool,
}

/// One decoded keystroke unit split out of a raw read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unit {
    /// Original bytes — forwarded to claude verbatim unless swallowed.
    pub raw: Vec<u8>,
    /// Logical VT bytes for classification + combo matching (may be empty
    /// for keys with no text/VT form, e.g. arrows → forwarded, never matched).
    pub vt: Vec<u8>,
    /// Key-down (true) vs key-up (false). Non-win32 units are treated as down.
    pub is_down: bool,
}

// --- classifiers (mirror is_typing_keystroke / _is_lone_esc) ----------------

/// True if `vt` is a printable human TEXT keystroke (paint `stop`). Excludes
/// ESC, C0 controls (Enter, Tab, Ctrl-combos), and DEL.
pub fn is_typing(vt: &[u8]) -> bool {
    match vt.first() {
        Some(&b0) => b0 != 0x1b && b0 >= 0x20 && b0 != 0x7f,
        None => false,
    }
}

/// True if `vt` is a bare ESC (claude interrupt / human takeover), NOT an
/// ESC-led CSI/SS3 (arrows, F-keys → `ESC[` / `ESCO`).
pub fn is_lone_esc(vt: &[u8]) -> bool {
    match vt {
        [0x1b] => true,
        [0x1b, b, ..] => *b != 0x5b && *b != 0x4f, // not CSI '[' nor SS3 'O'
        _ => false,
    }
}

// --- win32-input-mode decode -----------------------------------------------

// Virtual-key codes we map to a VT form (subset afk-key.ts can name).
const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0d;
const VK_ESCAPE: u32 = 0x1b;
const VK_SPACE: u32 = 0x20;
const VK_DELETE: u32 = 0x2e;
const VK_F1: u32 = 0x70;
const VK_F12: u32 = 0x7b;

// Cs (control-key-state) bits.
const ALT_PRESSED: u32 = 0x0001 | 0x0002; // RIGHT_ALT | LEFT_ALT

/// xterm sequences for F1..F12, indexed by vk - VK_F1. Matches afk-key.ts NAMED.
const F_KEYS: [&[u8]; 12] = [
    &[0x1b, 0x4f, 0x50],             // F1  ESC O P
    &[0x1b, 0x4f, 0x51],             // F2  ESC O Q
    &[0x1b, 0x4f, 0x52],             // F3  ESC O R
    &[0x1b, 0x4f, 0x53],             // F4  ESC O S
    &[0x1b, 0x5b, 0x31, 0x35, 0x7e], // F5  ESC [ 1 5 ~
    &[0x1b, 0x5b, 0x31, 0x37, 0x7e], // F6  ESC [ 1 7 ~
    &[0x1b, 0x5b, 0x31, 0x38, 0x7e], // F7  ESC [ 1 8 ~
    &[0x1b, 0x5b, 0x31, 0x39, 0x7e], // F8  ESC [ 1 9 ~
    &[0x1b, 0x5b, 0x32, 0x30, 0x7e], // F9  ESC [ 2 0 ~
    &[0x1b, 0x5b, 0x32, 0x31, 0x7e], // F10 ESC [ 2 1 ~
    &[0x1b, 0x5b, 0x32, 0x33, 0x7e], // F11 ESC [ 2 3 ~
    &[0x1b, 0x5b, 0x32, 0x34, 0x7e], // F12 ESC [ 2 4 ~
];

fn utf8_bytes(uc: u32) -> Vec<u8> {
    match char::from_u32(uc) {
        Some(c) => c.to_string().into_bytes(),
        None => Vec::new(),
    }
}

/// Decode a win32-input-mode key event to the VT byte form it represents, so
/// it can be classified / matched against the (VT-byte) AFK combos. Covers the
/// keys afk-key.ts can name (named keys, F1-F12, ctrl/alt chords, literals);
/// returns empty for keys with no text/VT form here (e.g. arrows), which then
/// forward verbatim but never match a combo or read as typing.
pub fn win32_to_vt(vk: u32, uc: u32, cs: u32) -> Vec<u8> {
    let alt = cs & ALT_PRESSED != 0;
    let mut base: Vec<u8> = match vk {
        VK_ESCAPE => vec![0x1b],
        VK_TAB => vec![0x09],
        VK_RETURN => vec![0x0d],
        VK_BACK => vec![0x7f], // backspace → DEL (afk NAMED.bs)
        VK_SPACE => vec![0x20],
        VK_DELETE => vec![0x1b, 0x5b, 0x33, 0x7e],
        VK_F1..=VK_F12 => F_KEYS[(vk - VK_F1) as usize].to_vec(),
        // ctrl+<char> gives Uc = the control byte; printable gives Uc = char.
        _ => {
            if uc != 0 {
                utf8_bytes(uc)
            } else {
                Vec::new()
            }
        }
    };
    if alt && !base.is_empty() {
        base.insert(0, 0x1b); // Alt = ESC prefix (matches parseCombo)
    }
    base
}

// --- split a raw read into decoded keystroke units --------------------------

fn parse_field(b: &[u8]) -> u32 {
    let mut v: u32 = 0;
    for &c in b {
        if c.is_ascii_digit() {
            v = v.saturating_mul(10).saturating_add((c - b'0') as u32);
        } else {
            return 0;
        }
    }
    v
}

/// Split a raw stdin read into individual keystroke units (#381). On Windows
/// the read is win32-input-mode, which already delineates one key per
/// `_`-terminated CSI, so this is mostly a parser:
/// - `ESC[…_`  → a win32 key event → decode (vt + down/up).
/// - `ESC[…X` (X final 0x40-0x7e, not `_`) → a regular CSI (arrow / DSR) kept
///   whole, vt = the bytes (already VT), treated as down.
/// - `ESC O .` (SS3) → kept whole.
/// - any other run → raw bytes (paste / non-ESC), vt = the bytes, down.
pub fn split_units(data: &[u8]) -> Vec<Unit> {
    let n = data.len();
    let mut units = Vec::new();
    let mut i = 0;
    while i < n {
        if data[i] == 0x1b && i + 1 < n && data[i + 1] == 0x5b {
            // CSI: scan to the final byte (first byte in 0x40..=0x7e).
            let start = i + 2;
            let mut j = start;
            while j < n && !(0x40..=0x7e).contains(&data[j]) {
                j += 1;
            }
            if j < n {
                let final_b = data[j];
                let seq = data[i..=j].to_vec();
                if final_b == b'_' {
                    // win32-input-mode: Vk;Sc;Uc;Kd;Cs;Rc
                    let fields: Vec<&[u8]> = data[start..j].split(|&c| c == b';').collect();
                    let vk = fields.first().map(|f| parse_field(f)).unwrap_or(0);
                    let uc = fields.get(2).map(|f| parse_field(f)).unwrap_or(0);
                    let kd = fields.get(3).map(|f| parse_field(f)).unwrap_or(1);
                    let cs = fields.get(4).map(|f| parse_field(f)).unwrap_or(0);
                    units.push(Unit {
                        raw: seq,
                        vt: win32_to_vt(vk, uc, cs),
                        is_down: kd == 1,
                    });
                } else {
                    // Regular CSI (arrow, DSR response, …): keep whole, it's VT.
                    units.push(Unit { vt: seq.clone(), raw: seq, is_down: true });
                }
                i = j + 1;
                continue;
            }
            // Unterminated CSI at end of buffer — emit the rest as one unit.
            let seq = data[i..].to_vec();
            units.push(Unit { vt: seq.clone(), raw: seq, is_down: true });
            break;
        }
        if data[i] == 0x1b && i + 1 < n && data[i + 1] == 0x4f {
            // SS3: ESC O <byte>
            let end = (i + 3).min(n);
            let seq = data[i..end].to_vec();
            units.push(Unit { vt: seq.clone(), raw: seq, is_down: true });
            i = end;
            continue;
        }
        // Raw run until the next ESC (paste / plain bytes — rare in win32 mode).
        let mut j = i;
        while j < n && data[j] != 0x1b {
            j += 1;
        }
        if j == i {
            j = i + 1; // lone ESC at end
        }
        let seq = data[i..j].to_vec();
        units.push(Unit { vt: seq.clone(), raw: seq, is_down: true });
        i = j;
    }
    units
}

// --- AFK spec + detector (mirror afk-key.ts / _AfkDetector) -----------------

/// Parse `CL_AFK_SPEC` (`[[27,97],[7]]` — JSON list of byte lists, from the TS
/// `parseAfkKey`) into combos. Tolerant hand-parser (no serde dep): anything
/// malformed yields no combos (AFK disabled), like the Python `except`.
pub fn parse_afk_spec(json: &str) -> Vec<Vec<u8>> {
    let mut combos = Vec::new();
    let mut cur: Option<Vec<u8>> = None;
    let mut num = String::new();
    let mut depth = 0u8;
    let flush_num = |num: &mut String, cur: &mut Option<Vec<u8>>| {
        if let Some(c) = cur {
            if !num.is_empty() {
                if let Ok(v) = num.parse::<u32>() {
                    if v <= 255 {
                        c.push(v as u8);
                    }
                }
            }
        }
        num.clear();
    };
    for ch in json.chars() {
        match ch {
            '[' => {
                depth += 1;
                if depth == 2 {
                    cur = Some(Vec::new());
                }
            }
            ']' => {
                flush_num(&mut num, &mut cur);
                if depth == 2 {
                    if let Some(c) = cur.take() {
                        if !c.is_empty() {
                            combos.push(c);
                        }
                    }
                }
                depth = depth.saturating_sub(1);
            }
            ',' => flush_num(&mut num, &mut cur),
            c if c.is_ascii_digit() => num.push(c),
            _ => {}
        }
    }
    combos
}

/// Atomic-combo AFK detector (#381). A keystroke that EXACTLY matches one of
/// the configured combos fires (a TOGGLE). `window_ms` is a post-fire debounce
/// only: a held chord key-repeats the same bytes, so for `window_ms` after a
/// fire any keystroke made solely of combo bytes is swallowed (one net toggle
/// per physical press). Anything else ends the debounce. Mirror of
/// afk-key.ts AfkDetector + the Python _AfkDetector.
pub struct AfkDetector {
    combos: Vec<Vec<u8>>,
    window_ms: f64,
    cooldown_until: f64,
    last_residual: bool,
    combo_bytes: Vec<bool>, // 256-wide membership set
}

impl AfkDetector {
    pub fn new(combos: Vec<Vec<u8>>, window_ms: f64) -> Self {
        let mut combo_bytes = vec![false; 256];
        for c in &combos {
            for &b in c {
                combo_bytes[b as usize] = true;
            }
        }
        AfkDetector {
            combos,
            window_ms,
            cooldown_until: 0.0,
            last_residual: false,
            combo_bytes,
        }
    }

    /// True iff the last `feed` swallowed a key-repeat residual.
    pub fn residual(&self) -> bool {
        self.last_residual
    }

    /// True if `vt` matches any combo (used to swallow combo key-UPs too).
    pub fn matches(&self, vt: &[u8]) -> bool {
        self.combos.iter().any(|c| c.as_slice() == vt)
    }

    /// Feed one keystroke's VT bytes. Returns true on a toggle.
    pub fn feed(&mut self, vt: &[u8], now_ms: f64) -> bool {
        self.last_residual = false;
        if self.combos.is_empty() {
            return false;
        }
        if now_ms < self.cooldown_until {
            if !vt.is_empty() && vt.iter().all(|&b| self.combo_bytes[b as usize]) {
                self.last_residual = true;
                return false;
            }
            self.cooldown_until = 0.0; // any other key ends the debounce
        }
        if self.combos.iter().any(|c| c.as_slice() == vt) {
            self.cooldown_until = now_ms + self.window_ms;
            return true; // TOGGLE
        }
        false
    }
}

// --- the pure decider -------------------------------------------------------

pub struct Decider {
    afk: AfkDetector,
    esc_takeover: bool,
    pub afk_active: bool,
    /// ms timestamp of the last text keystroke (live loop reads it for the
    /// "revert stop→rest after the typing TTL" decision).
    pub last_keystroke_ms: f64,
}

impl Decider {
    pub fn new(combos: Vec<Vec<u8>>, esc_takeover: bool, window_ms: f64) -> Self {
        Decider {
            afk: AfkDetector::new(combos, window_ms),
            esc_takeover,
            afk_active: false,
            last_keystroke_ms: 0.0,
        }
    }

    fn empty(&self) -> Verdict {
        Verdict {
            forward: Vec::new(),
            markers: Vec::new(),
            word: Word::None,
            afk_fired: false,
            typing: false,
            lone_esc: false,
            afk_active: self.afk_active,
        }
    }

    /// Decide on one keystroke unit. Mirrors `_Decider.on_stdin`, adapted so
    /// `forward` carries the unit's RAW (win32) bytes for passthrough.
    pub fn on_unit(&mut self, unit: &Unit, now_ms: f64) -> Verdict {
        // Key-UP events: never drive detection. Swallow if it's a combo key
        // (its key-DOWN was swallowed too); otherwise forward verbatim.
        if !unit.is_down {
            let mut v = self.empty();
            if !self.afk.matches(&unit.vt) {
                v.forward = unit.raw.clone();
            }
            return v;
        }

        // (a) AFK combo → toggle, swallow (nothing reaches claude).
        if self.afk.feed(&unit.vt, now_ms) {
            let mut v = self.empty();
            v.afk_fired = true;
            if self.afk_active {
                v.markers = vec![Marker::ClearAfk, Marker::TouchUserGrace]; // back
                self.afk_active = false;
            } else {
                v.markers = vec![Marker::SetAfk, Marker::ClearUserGrace]; // away
                self.afk_active = true;
            }
            v.afk_active = self.afk_active;
            v.word = Word::Rest;
            return v; // forward stays empty
        }

        // (a') Debounced key-repeat residual of the just-fired combo → swallow.
        if self.afk.residual() {
            return self.empty();
        }

        let mut v = self.empty();
        if is_typing(&unit.vt) {
            v.typing = true;
            v.markers = vec![Marker::ClearAfk, Marker::TouchTyping, Marker::TouchUserGrace];
            self.afk_active = false;
            self.last_keystroke_ms = now_ms;
            v.word = Word::Stop;
        } else if self.esc_takeover && is_lone_esc(&unit.vt) {
            v.lone_esc = true;
            v.markers = vec![Marker::ClearAfk, Marker::TouchUserGrace];
            self.afk_active = false;
            v.word = Word::Rest;
        }
        v.afk_active = self.afk_active;
        v.forward = unit.raw.clone();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a win32-input-mode key event byte sequence.
    fn w32(vk: u32, uc: u32, kd: u32, cs: u32) -> Vec<u8> {
        format!("\x1b[{vk};0;{uc};{kd};{cs};1_").into_bytes()
    }
    // Common keys as win32 down events.
    fn k_char(c: char) -> Vec<u8> {
        w32(c.to_ascii_uppercase() as u32, c as u32, 1, 0)
    }
    fn k_f9() -> Vec<u8> {
        w32(0x78, 0, 1, 0)
    } // VK_F9, Uc=0
    fn k_ctrl_g() -> Vec<u8> {
        w32(b'G' as u32, 7, 1, 0x0008)
    } // ctrl → Uc=7, CTRL bit
    fn k_alt_a() -> Vec<u8> {
        w32(b'A' as u32, b'a' as u32, 1, 0x0002)
    } // LEFT_ALT
    fn k_esc() -> Vec<u8> {
        w32(0x1b, 0x1b, 1, 0)
    }

    // --- win32_to_vt ---
    #[test]
    fn decode_keys_to_vt() {
        assert_eq!(win32_to_vt(b'A' as u32, b'a' as u32, 0), vec![0x61]); // 'a'
        assert_eq!(win32_to_vt(0x78, 0, 0), vec![0x1b, 0x5b, 0x32, 0x30, 0x7e]); // F9
        assert_eq!(win32_to_vt(b'G' as u32, 7, 0x0008), vec![0x07]); // ctrl+g
        assert_eq!(win32_to_vt(b'A' as u32, b'a' as u32, 0x0002), vec![0x1b, 0x61]); // alt+a
        assert_eq!(win32_to_vt(0x1b, 0x1b, 0), vec![0x1b]); // ESC
        assert_eq!(win32_to_vt(0x25, 0, 0), Vec::<u8>::new()); // Left arrow → none
    }

    // --- split_units ---
    #[test]
    fn split_one_win32_event() {
        let u = split_units(&k_char('a'));
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].vt, vec![0x61]);
        assert!(u[0].is_down);
    }

    #[test]
    fn split_coalesced_two_events() {
        let mut data = k_f9();
        data.extend(k_f9());
        let u = split_units(&data);
        assert_eq!(u.len(), 2); // re-split into 2 keystrokes
    }

    #[test]
    fn split_keeps_regular_csi_whole() {
        // Arrow ESC[A and a DSR reply ESC[1;1R must not be dislocated.
        let u = split_units(b"\x1b[A");
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].vt, b"\x1b[A");
        let d = split_units(b"\x1b[1;1R");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].vt, b"\x1b[1;1R");
    }

    // --- classifiers ---
    #[test]
    fn classifiers() {
        assert!(is_typing(&[0x61])); // 'a'
        assert!(is_typing(&[0x20])); // space
        assert!(!is_typing(&[0x1b])); // ESC
        assert!(!is_typing(&[0x0d])); // Enter
        assert!(!is_typing(&[])); // empty
        assert!(is_lone_esc(&[0x1b]));
        assert!(!is_lone_esc(&[0x1b, 0x5b, 0x41])); // arrow
        assert!(!is_lone_esc(&[0x61]));
    }

    // --- parse_afk_spec ---
    #[test]
    fn parse_spec() {
        assert_eq!(parse_afk_spec("[[27,97]]"), vec![vec![27, 97]]);
        assert_eq!(parse_afk_spec("[[7],[27,97]]"), vec![vec![7], vec![27, 97]]);
        assert_eq!(parse_afk_spec("[]"), Vec::<Vec<u8>>::new());
        assert_eq!(parse_afk_spec("garbage"), Vec::<Vec<u8>>::new());
    }

    // --- AfkDetector ---
    #[test]
    fn detector_single_combo_toggles() {
        let mut d = AfkDetector::new(vec![vec![7]], 400.0);
        assert!(d.feed(&[7], 0.0)); // toggle
        assert!(!d.feed(&[0x61], 1000.0)); // other key, no fire
    }

    #[test]
    fn detector_debounce_swallows_repeat() {
        let mut d = AfkDetector::new(vec![vec![27, 97]], 400.0);
        assert!(d.feed(&[27, 97], 0.0)); // fire
        assert!(!d.feed(&[27, 97], 100.0)); // within window → residual
        assert!(d.residual());
    }

    // --- Decider end-to-end (mirrors pty-proxy.test.ts) ---
    fn decide(d: &mut Decider, raw: &[u8], now_ms: f64) -> Vec<Verdict> {
        split_units(raw).iter().map(|u| d.on_unit(u, now_ms)).collect()
    }

    #[test]
    fn combo_toggles_on_then_off_swallowed() {
        let mut d = Decider::new(vec![vec![27, 97]], true, 400.0); // alt+a
        let v1 = decide(&mut d, &k_alt_a(), 0.0);
        assert!(v1[0].afk_fired && v1[0].afk_active);
        assert!(v1[0].forward.is_empty());
        assert!(v1[0].markers.contains(&Marker::SetAfk));
        let v2 = decide(&mut d, &k_alt_a(), 5000.0);
        assert!(!v2[0].afk_active); // toggled back
        assert!(v2[0].markers.contains(&Marker::ClearAfk));
    }

    #[test]
    fn coalesced_repeat_one_toggle() {
        let mut d = Decider::new(vec![vec![27, 97]], true, 400.0);
        let mut data = k_alt_a();
        data.extend(k_alt_a()); // alt+a alt+a in one read
        let v = decide(&mut d, &data, 0.0);
        assert_eq!(v.len(), 2);
        assert!(v[0].afk_fired);
        assert!(!v[1].afk_fired); // 2nd swallowed by debounce
        assert!(v.last().unwrap().afk_active);
    }

    #[test]
    fn esc_alone_forwarded_no_toggle() {
        let mut d = Decider::new(vec![vec![27, 97]], true, 400.0);
        let v = decide(&mut d, &k_esc(), 0.0);
        assert_eq!(v.len(), 1);
        assert!(!v[0].afk_fired);
        assert!(v[0].lone_esc);
        assert_eq!(v[0].forward, k_esc()); // forwarded now
    }

    #[test]
    fn ordinary_text_typing() {
        let mut d = Decider::new(vec![vec![27, 97]], true, 400.0);
        let v = decide(&mut d, &k_char('a'), 0.0);
        assert!(v[0].typing);
        assert_eq!(v[0].word, Word::Stop);
        assert!(v[0].markers.contains(&Marker::TouchUserGrace));
        assert_eq!(v[0].forward, k_char('a'));
    }

    #[test]
    fn text_after_afk_clears() {
        let mut d = Decider::new(vec![vec![27, 97]], true, 400.0);
        decide(&mut d, &k_alt_a(), 0.0); // away
        let v = decide(&mut d, &k_char('a'), 2000.0);
        assert!(!v[0].afk_active);
        assert!(v[0].markers.contains(&Marker::ClearAfk));
    }

    #[test]
    fn f9_default_toggles() {
        let mut d = Decider::new(vec![vec![0x1b, 0x5b, 0x32, 0x30, 0x7e]], true, 400.0); // f9
        let v = decide(&mut d, &k_f9(), 0.0);
        assert!(v[0].afk_fired && v[0].afk_active);
        assert!(v[0].forward.is_empty());
    }

    #[test]
    fn ctrl_g_toggles() {
        let mut d = Decider::new(vec![vec![7]], true, 400.0);
        let v = decide(&mut d, &k_ctrl_g(), 0.0);
        assert!(v[0].afk_fired);
        assert!(v[0].forward.is_empty());
    }

    #[test]
    fn alternatives_each_toggle() {
        let mut d = Decider::new(vec![vec![7], vec![27, 97]], true, 400.0); // ctrl+g OR alt+a
        let v1 = decide(&mut d, &k_ctrl_g(), 0.0);
        assert!(v1[0].afk_active);
        let v2 = decide(&mut d, &k_alt_a(), 2000.0);
        assert!(!v2[0].afk_active);
    }

    #[test]
    fn arrow_forwarded_intact() {
        let mut d = Decider::new(vec![vec![0x1b, 0x5b, 0x32, 0x30, 0x7e]], true, 400.0);
        let v = decide(&mut d, b"\x1b[A", 0.0);
        assert_eq!(v.len(), 1);
        assert!(!v[0].afk_fired);
        assert_eq!(v[0].forward, b"\x1b[A");
    }
}
