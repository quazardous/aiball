/**
 * #351 / #381: parse + detect the configurable AFK key/combo.
 *
 * #381 (david s4r9n8 "on laisse tomber les fenêtres avec timing — seul les
 * combinaisons comptent"): an afk_key is now ONE OR MORE *atomic* combos
 * (chords), pressing ANY of them TOGGLES AFK. There is NO 2-press timing
 * sequence anymore — that was irreparably ambiguous (a held/repeated key reads
 * as duplicate bytes, indistinguishable from two deliberate taps; and ESC, the
 * old default, doubles as claude's interrupt). A space in `afk_key` now means
 * "OR" (alternatives), not a sequence. `afk_window_ms` survives only as a
 * post-fire key-repeat DEBOUNCE (a held chord toggles once, not N times).
 *
 * `+` joins modifiers within one chord (e.g. `ctrl+g`, `alt+a`). We only see
 * the terminal's byte stream in the PTY proxy (not OS key events), so we cover
 * the subset that maps to distinct bytes: `ctrl+<char>`, f-keys, `alt+<char>`,
 * named keys, literals. A bare `esc` is rejected (it IS the interrupt key).
 *
 * Both halves are pure / clock-injectable so they unit-test cleanly
 * (see afk-key.test.ts) — no real timers, no PTY needed.
 */

/** One keystroke encoded as the bytes the terminal emits for it. */
export type Combo = number[];

export interface AfkSpec {
    /** #381: one or more ALTERNATIVE atomic combos — pressing ANY toggles AFK.
     *  No more 2-combo timing sequence. */
    combos: Combo[];
    /** #381: post-fire key-repeat DEBOUNCE in ms (a held chord toggles once).
     *  NOT a sequence window anymore. */
    windowMs: number;
}

// xterm-standard escape sequences for the named keys we support.
const NAMED: Record<string, number[]> = {
    esc: [0x1b],
    tab: [0x09],
    enter: [0x0d],
    ret: [0x0d],
    space: [0x20],
    bs: [0x7f],
    backspace: [0x7f],
    del: [0x1b, 0x5b, 0x33, 0x7e], // ESC [ 3 ~
    f1: [0x1b, 0x4f, 0x50],
    f2: [0x1b, 0x4f, 0x51],
    f3: [0x1b, 0x4f, 0x52],
    f4: [0x1b, 0x4f, 0x53],
    f5: [0x1b, 0x5b, 0x31, 0x35, 0x7e],
    f6: [0x1b, 0x5b, 0x31, 0x37, 0x7e],
    f7: [0x1b, 0x5b, 0x31, 0x38, 0x7e],
    f8: [0x1b, 0x5b, 0x31, 0x39, 0x7e],
    f9: [0x1b, 0x5b, 0x32, 0x30, 0x7e],
    f10: [0x1b, 0x5b, 0x32, 0x31, 0x7e],
    f11: [0x1b, 0x5b, 0x32, 0x33, 0x7e],
    f12: [0x1b, 0x5b, 0x32, 0x34, 0x7e],
};

function keyToBytes(key: string): number[] {
    const k = key.toLowerCase();
    if (k in NAMED) return [...NAMED[k]];
    if (key.length === 1) return [key.charCodeAt(0)];
    throw new Error(`afk_key: unknown key "${key}"`);
}

/** One combo token, e.g. `ctrl+a`, `esc`, `f9`, `alt+x`, `ctrl+]`. */
function parseCombo(tok: string): Combo {
    const segs = tok.split("+").filter((s) => s.length > 0);
    const key = segs.pop();
    if (!key) throw new Error(`afk_key: empty combo in "${tok}"`);
    const mods = new Set(segs.map((s) => s.toLowerCase()));
    let bytes: number[];
    if (mods.has("ctrl")) {
        // Ctrl+<char> = the control byte (char & 0x1f): a→0x01, ]→0x1d, …
        if (key.length !== 1) {
            throw new Error(`afk_key: ctrl+ needs a single char, got "${key}"`);
        }
        bytes = [key.toLowerCase().charCodeAt(0) & 0x1f];
    } else {
        bytes = keyToBytes(key);
    }
    if (mods.has("alt")) bytes = [0x1b, ...bytes]; // Alt = ESC prefix
    return bytes;
}

/**
 * #381: parse an `afk_key` string into an {@link AfkSpec}. Space-separated
 * combos are ALTERNATIVES (press any → toggle). At least one combo required.
 * A bare ESC combo is rejected — it doubles as claude's interrupt key, the
 * very conflation #381 removed. Callers log + fall back to the default.
 */
export function parseAfkKey(spec: string, windowMs: number): AfkSpec {
    const parts = spec.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length < 1) {
        throw new Error(`afk_key is empty: "${spec}"`);
    }
    const combos = parts.map(parseCombo);
    for (const c of combos) {
        if (c.length === 1 && c[0] === 0x1b) {
            throw new Error(
                `afk_key: a bare ESC conflicts with claude's interrupt key — use a chord (ctrl+…, alt+…, an f-key)`,
            );
        }
    }
    return { combos, windowMs };
}

function bytesEqual(a: ArrayLike<number>, b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Lowercase hex of a byte sequence, no separators: [0x1b,0x1b] → "1b1b". */
function toHex(bytes: ArrayLike<number>): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
}

// Reverse of NAMED (hex → name), derived so it never drifts. When several names
// share a byte sequence (ret/enter on 0x0d, bs/backspace on 0x7f) the canonical
// one wins.
const NAMED_CANON = new Set([
    "esc", "tab", "enter", "space", "backspace", "del",
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
const REVERSE_NAMED: Record<string, string> = (() => {
    const m: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(NAMED)) {
        const h = toHex(bytes);
        if (!(h in m) || NAMED_CANON.has(name)) m[h] = name;
    }
    return m;
})();

// CSI / SS3 escape sequences we can name but that aren't valid afk combos
// (arrows / nav) — so the decoder labels them instead of mis-reading the ESC
// prefix as `alt+[`.
const ESC_SEQ: Record<string, string> = {
    "1b5b41": "up", "1b5b42": "down", "1b5b43": "right", "1b5b44": "left",
    "1b5b48": "home", "1b5b46": "end", "1b5b357e": "pgup", "1b5b367e": "pgdn",
};

/** Decode ONE simple key (1 byte, or a named single like ESC) to grammar, or null. */
function decodeSingle(bytes: number[]): string | null {
    const named = REVERSE_NAMED[toHex(bytes)];
    if (named) return named;
    if (bytes.length !== 1) return ESC_SEQ[toHex(bytes)] ?? null;
    const b = bytes[0];
    if (b < 0x20) {
        // Inverse of `ctrl+<char>` = char & 0x1f → restore the 0x40 bit.
        const c = b | 0x40;
        const ch = String.fromCharCode(c);
        return "ctrl+" + (c >= 0x41 && c <= 0x5a ? ch.toLowerCase() : ch);
    }
    if (b >= 0x21 && b <= 0x7e) return String.fromCharCode(b); // printable literal
    return null;
}

/**
 * #381 (david yf8wht): inverse of {@link parseCombo} — decode a keystroke's raw
 * bytes back into the afk_key grammar (`alt+esc`, `ctrl+g`, `f9`, `a`, …). Powers
 * the `debug-keys` tool: pressing a key shows WHAT the terminal actually
 * delivered, so david can confirm whether GNOME/tmux swallows `alt+esc` (it'd
 * print nothing or different bytes instead of `1b1b`). Lossless fallback:
 * anything unnameable renders as `<hex …>`, never dropped.
 */
export function bytesToGrammar(bytes: ArrayLike<number>): string {
    const arr = Array.from(bytes);
    if (arr.length === 0) return "(empty)";
    const h = toHex(arr);
    if (REVERSE_NAMED[h]) return REVERSE_NAMED[h]; // esc/tab/enter/space/backspace/del/f-keys
    if (ESC_SEQ[h]) return ESC_SEQ[h]; // arrows / nav
    // Alt = ESC prefix on a simple key — but NOT a CSI (ESC [) / SS3 (ESC O) seq.
    if (arr.length >= 2 && arr[0] === 0x1b && arr[1] !== 0x5b && arr[1] !== 0x4f) {
        const inner = decodeSingle(arr.slice(1));
        if (inner) return "alt+" + inner;
    }
    if (arr.length === 1) {
        const single = decodeSingle(arr);
        if (single) return single;
    }
    // Printable non-ASCII key (e.g. AZERTY `²` = UTF-8 `c2 b2`): show the literal
    // character — it's a real key, just not encodable as an afk combo (those are
    // ASCII control/alt/ctrl chords). The hex stays visible in the byte column.
    try {
        const s = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(arr));
        if ([...s].length === 1 && !/\p{Cc}/u.test(s)) return s;
    } catch { /* not valid UTF-8 — fall through to the hex catch-all */ }
    return `<hex ${h}>`; // lossless catch-all: unmappable bytes, never dropped
}

/**
 * Pure combo match (no debounce state): does `bytes` exactly equal one of the
 * spec's atomic combos? Used by the `debug-keys` diagnostic to flag a keystroke
 * that WOULD toggle AFK, without touching the stateful {@link AfkDetector}.
 */
export function matchAfkCombo(bytes: ArrayLike<number>, spec: AfkSpec): boolean {
    for (const c of spec.combos) if (bytesEqual(bytes, c)) return true;
    return false;
}

/** #381b: every byte of `bytes` belongs to the combo's byte set. */
function allComboBytes(bytes: ArrayLike<number>, set: Set<number>): boolean {
    if (bytes.length === 0) return false;
    for (let i = 0; i < bytes.length; i++) if (!set.has(bytes[i])) return false;
    return true;
}

/**
 * #381: stateful AFK detector. Fed ONE keystroke's bytes at a time (the PTY
 * proxy delivers per-keystroke chunks), current time injected. Returns true
 * each time a keystroke EXACTLY matches one of the configured atomic combos —
 * a TOGGLE. No 2-press sequence: a single chord match fires immediately.
 *
 * The only timing left is a post-fire DEBOUNCE (`windowMs`): a held chord
 * key-repeats the same bytes, which would toggle N times; for `windowMs` after
 * a fire any keystroke made solely of combo bytes is swallowed (one net toggle
 * per physical press, regardless of OS key-repeat). Anything else ends the
 * debounce immediately.
 */
export class AfkDetector {
    private cooldownUntil = 0;
    private lastResidual = false;
    private readonly comboBytes: Set<number>;

    constructor(private readonly spec: AfkSpec) {
        this.comboBytes = new Set<number>();
        for (const c of spec.combos) for (const b of c) this.comboBytes.add(b);
    }

    /** True iff the last {@link feed} swallowed a key-repeat residual during the
     *  post-fire debounce — caller drops it (no forward, afk unchanged). */
    get residual(): boolean {
        return this.lastResidual;
    }

    /** @param bytes one keystroke's bytes. @param now ms clock. */
    feed(bytes: ArrayLike<number>, now: number): boolean {
        this.lastResidual = false;
        if (this.spec.combos.length === 0) return false;
        // Debounce: swallow key-repeat of the just-fired combo's bytes.
        if (now < this.cooldownUntil) {
            if (allComboBytes(bytes, this.comboBytes)) {
                this.lastResidual = true;
                return false;
            }
            this.cooldownUntil = 0; // any other key ends the debounce
        }
        for (const c of this.spec.combos) {
            if (bytesEqual(bytes, c)) {
                this.cooldownUntil = now + this.spec.windowMs;
                return true; // TOGGLE
            }
        }
        return false;
    }

    /** Forget the debounce (e.g. on detach). */
    reset(): void {
        this.cooldownUntil = 0;
        this.lastResidual = false;
    }
}
