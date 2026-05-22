/**
 * #351: parse + detect the configurable AFK key/combo.
 *
 * `afk_key` uses VS Code-style notation (researched on #351): `+` joins
 * modifiers within a combo, a SPACE separates a 2-combo sequence. Scope is
 * deliberately small (david "réduire la voilure"): EITHER a single combo,
 * OR a sequence of exactly two — the second within `afk_window_ms` of the
 * first. The timing knob is separate (kitty `map_timeout` style), not inline.
 *
 * The parser maps the friendly description → raw byte patterns (we only see
 * the terminal's byte stream in the PTY proxy, not OS key events — so we
 * cover the subset that maps to distinct bytes: `esc`, `ctrl+<char>`,
 * f-keys, literals; `shift`/`alt+shift`/`ctrl+shift` aren't distinguishable
 * without the kitty/win32 keyboard protocol).
 *
 * Both halves are pure / clock-injectable, so they unit-test cleanly
 * (see afk-key.test.ts) — no real timers, no PTY needed.
 */

/** One keystroke encoded as the bytes the terminal emits for it. */
export type Combo = number[];

export interface AfkSpec {
    /** 1 or 2 combos (single combo, or a 2-combo sequence). */
    combos: Combo[];
    /** Max ms between the two combos of a sequence (ignored for a single). */
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
 * Parse an `afk_key` string into an {@link AfkSpec}. Accepts exactly one or
 * two space-separated combos. Throws on an empty / >2-combo / unknown-key
 * spec (callers log + fall back to the default).
 */
export function parseAfkKey(spec: string, windowMs: number): AfkSpec {
    const parts = spec.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length < 1 || parts.length > 2) {
        throw new Error(
            `afk_key must be 1 or 2 combos, got ${parts.length}: "${spec}"`,
        );
    }
    return { combos: parts.map(parseCombo), windowMs };
}

function bytesEqual(a: ArrayLike<number>, b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Stateful AFK detector. Fed ONE keystroke's bytes at a time (the PTY proxy
 * delivers per-keystroke chunks), with the current time injected — so the
 * window logic is deterministic in tests. Returns true exactly once, on the
 * keystroke that completes the combo/sequence.
 *
 * Matching is exact-per-keystroke, which also disambiguates a bare ESC
 * (`[0x1b]`) from an ESC-led sequence like an arrow key (`[0x1b,0x5b,0x41]`).
 */
export class AfkDetector {
    private firstAt: number | null = null;

    constructor(private readonly spec: AfkSpec) {}

    /** @param bytes one keystroke's bytes. @param now ms clock. */
    feed(bytes: ArrayLike<number>, now: number): boolean {
        const [c1, c2] = this.spec.combos;
        if (!c2) return bytesEqual(bytes, c1); // single combo

        // Second combo arrived in time → fire.
        if (
            this.firstAt !== null &&
            now - this.firstAt <= this.spec.windowMs &&
            bytesEqual(bytes, c2)
        ) {
            this.firstAt = null;
            return true;
        }
        // Otherwise (re)evaluate as a potential first combo.
        if (bytesEqual(bytes, c1)) {
            this.firstAt = now;
            return false;
        }
        // Any other keystroke breaks a pending sequence.
        this.firstAt = null;
        return false;
    }

    /** Forget any pending first-combo (e.g. on detach). */
    reset(): void {
        this.firstAt = null;
    }
}
