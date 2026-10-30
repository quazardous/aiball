//! #4437 — a probe for one OSC sequence (`ESC ] 7501 ; … BEL|ST`) in what the
//! command writes, counted before vt100 sees it: vt100 drops the OSCs it does
//! not know, so the screen model never shows them. Measured only, so it can be
//! decided later whether it tells something about Claude (busy, idle) worth a
//! proof. A sequence may be split across reads: the probe keeps its state.

/// The payload kept of the last sequence, cut to this many bytes.
const PAYLOAD_MAX: usize = 200;

enum State {
    Ground,
    Esc,
    /// After `ESC ]`: the OSC number so far.
    Number(Vec<u8>),
    /// Inside the payload of an OSC; `keep` when it is the one counted.
    Payload { keep: bool, esc: bool },
}

pub struct OscProbe {
    number: &'static [u8],
    state: State,
    payload: Vec<u8>,
    pub count: u64,
    pub last: String,
}

impl OscProbe {
    pub fn new(number: &'static str) -> Self {
        Self { number: number.as_bytes(), state: State::Ground, payload: Vec::new(), count: 0, last: String::new() }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.state = match std::mem::replace(&mut self.state, State::Ground) {
                State::Ground => if b == 0x1b { State::Esc } else { State::Ground },
                State::Esc => if b == b']' { State::Number(Vec::new()) } else if b == 0x1b { State::Esc } else { State::Ground },
                State::Number(mut n) => {
                    if b.is_ascii_digit() && n.len() < 8 {
                        n.push(b);
                        State::Number(n)
                    } else if b == b';' {
                        let keep = n == self.number;
                        if keep { self.payload.clear(); }
                        State::Payload { keep, esc: false }
                    } else if b == 0x07 {
                        // An OSC with no payload.
                        if n == self.number { self.payload.clear(); self.done(); }
                        State::Ground
                    } else if b == 0x1b {
                        State::Esc
                    } else {
                        State::Ground
                    }
                }
                State::Payload { keep, esc } => {
                    if b == 0x07 || (esc && b == b'\\') {
                        if keep { self.done(); }
                        State::Ground
                    } else if b == 0x1b {
                        State::Payload { keep, esc: true }
                    } else if esc {
                        // ESC followed by anything but `\`: the OSC was cut off.
                        if b == b']' { State::Number(Vec::new()) } else { State::Ground }
                    } else {
                        if keep && self.payload.len() < PAYLOAD_MAX { self.payload.push(b); }
                        State::Payload { keep, esc: false }
                    }
                }
            };
        }
    }

    fn done(&mut self) {
        self.count += 1;
        self.last = String::from_utf8_lossy(&self.payload).into_owned();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_the_sequence_with_bel_or_st_and_keeps_its_payload() {
        let mut p = OscProbe::new("7501");
        p.feed(b"text\x1b]7501;busy\x07more\x1b]7501;idle\x1b\\end");
        assert_eq!(p.count, 2);
        assert_eq!(p.last, "idle");
    }

    #[test]
    fn other_oscs_and_csis_are_not_counted() {
        let mut p = OscProbe::new("7501");
        p.feed(b"\x1b]0;title\x07\x1b]750;x\x07\x1b]75011;x\x07\x1b[2J\x1b]8;;http://x\x1b\\");
        assert_eq!(p.count, 0);
    }

    #[test]
    fn a_sequence_split_across_reads_is_counted_once() {
        let mut p = OscProbe::new("7501");
        for chunk in [&b"ab\x1b"[..], b"]75", b"01;pa", b"yload\x1b", b"\\z"] {
            p.feed(chunk);
        }
        assert_eq!(p.count, 1);
        assert_eq!(p.last, "payload");
    }

    #[test]
    fn an_empty_one_counts_and_a_long_payload_is_cut() {
        let mut p = OscProbe::new("7501");
        p.feed(b"\x1b]7501\x07");
        assert_eq!((p.count, p.last.as_str()), (1, ""));
        let mut long = b"\x1b]7501;".to_vec();
        long.extend(std::iter::repeat(b'x').take(500));
        long.push(0x07);
        p.feed(&long);
        assert_eq!(p.count, 2);
        assert_eq!(p.last.len(), PAYLOAD_MAX);
    }
}
