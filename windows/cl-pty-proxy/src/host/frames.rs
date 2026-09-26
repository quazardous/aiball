//! #3066 — the attach protocol's frames (docs/LOOP-HOST.md): `[type: u8]
//! [length: u32 BE][payload]`. `snapshot` and `output` payloads start with an
//! 8-byte big-endian sequence number.

use std::io::{self, Read, Write};

use serde_json::Value;

pub const HELLO: u8 = 0x01;
pub const WELCOME: u8 = 0x02;
pub const SNAPSHOT: u8 = 0x03;
pub const OUTPUT: u8 = 0x04;
pub const INPUT: u8 = 0x05;
pub const RESIZE: u8 = 0x06;
pub const FOCUS: u8 = 0x07;
pub const SIZE: u8 = 0x08;
pub const SCREEN: u8 = 0x09;
pub const EXITED: u8 = 0x0a;
pub const CLOSED: u8 = 0x0b;
pub const ERROR: u8 = 0x0c;
pub const HISTORY_REQUEST: u8 = 0x0d;
pub const HISTORY: u8 = 0x0e;

/// A frame larger than this ends the connection: nothing legitimate is that big.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub fn encode(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn encode_json(kind: u8, v: &Value) -> Vec<u8> {
    encode(kind, v.to_string().as_bytes())
}

/// `snapshot` / `output`: the sequence number, then the bytes.
pub fn encode_seq(kind: u8, seq: u64, bytes: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8 + bytes.len());
    payload.extend_from_slice(&seq.to_be_bytes());
    payload.extend_from_slice(bytes);
    encode(kind, &payload)
}

pub fn read_frame(r: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok((head[0], payload))
}

pub fn write_frame(w: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    w.write_all(frame)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_frame_round_trips() {
        let f = encode_json(HELLO, &json!({ "version": 1 }));
        let (kind, payload) = read_frame(&mut &f[..]).unwrap();
        assert_eq!(kind, HELLO);
        assert_eq!(serde_json::from_slice::<Value>(&payload).unwrap()["version"], 1);
    }

    #[test]
    fn a_sequenced_frame_carries_its_seq_first() {
        let f = encode_seq(OUTPUT, 42, b"abc");
        let (_, payload) = read_frame(&mut &f[..]).unwrap();
        assert_eq!(u64::from_be_bytes(payload[..8].try_into().unwrap()), 42);
        assert_eq!(&payload[8..], b"abc");
    }

    #[test]
    fn an_oversized_frame_is_refused() {
        let mut f = vec![OUTPUT];
        f.extend_from_slice(&((MAX_FRAME + 1) as u32).to_be_bytes());
        assert!(read_frame(&mut &f[..]).is_err());
    }
}
