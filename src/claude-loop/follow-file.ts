/**
 * #3299 — `tail -n N -F <path>`, in Node: Windows has no `tail`, and the
 * `--follow` of `claude-loop tail` / `log` spawned it.
 *
 * Same behaviour as `-F`: the last `lines` lines first, then each new line as
 * it lands. A file that does not exist yet is waited for, and read whole when
 * it appears; a file truncated or replaced (rotation) is read again from its
 * start. Polled, as `tail -F` is on a file it cannot watch: `fs.watch` misses
 * appends on some Windows filesystems.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface FollowHandle {
    stop(): void;
}

export function followLines(
    path: string,
    lines: number,
    onLine: (line: string) => void,
    opts: { intervalMs?: number } = {},
): FollowHandle {
    // -1: the first look has not been made (its lines are the last `lines`).
    let pos = -1;
    let ino: number | bigint | null = null;
    let decoder = new StringDecoder("utf8");
    let carry = "";

    const readRange = (from: number, to: number): string => {
        const buf = Buffer.alloc(to - from);
        const fd = openSync(path, "r");
        try {
            let got = 0;
            while (got < buf.length) {
                const n = readSync(fd, buf, got, buf.length - got, from + got);
                if (n === 0) break;
                got += n;
            }
            return decoder.write(buf.subarray(0, got));
        } finally {
            closeSync(fd);
        }
    };

    const emit = (text: string, keepLast: number | null): void => {
        const parts = (carry + text).split("\n");
        carry = parts.pop() ?? "";
        // `slice(-0)` would keep them all: 0 lines asked is none.
        const out = keepLast === null ? parts : keepLast > 0 ? parts.slice(-keepLast) : [];
        for (const l of out) onLine(l.endsWith("\r") ? l.slice(0, -1) : l);
    };

    const tick = (): void => {
        let st;
        try {
            st = statSync(path);
        } catch {
            // Not there (yet, or between a rotation's two steps): read it whole when it comes.
            if (pos !== 0) { pos = 0; ino = null; carry = ""; decoder = new StringDecoder("utf8"); }
            return;
        }
        const first = pos === -1;
        if (!first && (st.size < pos || (ino !== null && st.ino !== ino))) {
            pos = 0; carry = ""; decoder = new StringDecoder("utf8");
        }
        ino = st.ino;
        const from = first ? 0 : pos;
        if (st.size > from) emit(readRange(from, st.size), first ? lines : null);
        pos = st.size;
    };

    tick();
    const timer = setInterval(tick, opts.intervalMs ?? 250);
    return {
        stop() {
            clearInterval(timer);
            if (carry) { onLine(carry); carry = ""; }
        },
    };
}
