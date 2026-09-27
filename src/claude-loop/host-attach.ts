/**
 * #3066 — `claude-loop attach` for a loop on the daemon's session host: a
 * terminal client of the host's attach socket (docs/LOOP-HOST.md, view
 * `stream`). The screen is repainted from the host's snapshot, then Claude's
 * output flows; the keys typed and the terminal's size go to the session, and
 * the host's keystroke detection (AFK) sees them as it sees tmux's.
 *
 * Detach with Ctrl-B D, as in tmux; Ctrl-B Ctrl-B sends one Ctrl-B. Leaving
 * stops nothing: Claude carries on on the host. #3166 — `readonly` watches a
 * copy: the keys go nowhere (Ctrl-B D still detaches) and the size stays the
 * other clients'.
 */
import { connect, type Socket } from "node:net";

export const FRAME = {
    hello: 0x01, welcome: 0x02, snapshot: 0x03, output: 0x04, input: 0x05, resize: 0x06,
    size: 0x08, exited: 0x0a, closed: 0x0b, error: 0x0c,
} as const;

const CTRL_B = 0x02;

export function frame(type: number, payload: Buffer | string): Buffer {
    const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    const head = Buffer.alloc(5);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(body.length, 1);
    return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames; what is incomplete waits for the next chunk. */
export class FrameReader {
    private buf = Buffer.alloc(0);
    push(chunk: Buffer): Array<{ type: number; payload: Buffer }> {
        this.buf = Buffer.concat([this.buf, chunk]);
        const out: Array<{ type: number; payload: Buffer }> = [];
        while (this.buf.length >= 5) {
            const len = this.buf.readUInt32BE(1);
            if (this.buf.length < 5 + len) break;
            out.push({ type: this.buf[0]!, payload: this.buf.subarray(5, 5 + len) });
            this.buf = this.buf.subarray(5 + len);
        }
        return out;
    }
}

/**
 * The keys typed, with the detach prefix taken out: Ctrl-B then D (or d)
 * detaches, Ctrl-B Ctrl-B is one Ctrl-B, Ctrl-B then anything else sends both.
 */
export class DetachKeys {
    private prefixed = false;
    feed(chunk: Buffer): { send: Buffer; detach: boolean } {
        const out: number[] = [];
        for (const b of chunk) {
            if (this.prefixed) {
                this.prefixed = false;
                if (b === 0x64 || b === 0x44) return { send: Buffer.from(out), detach: true };
                if (b === CTRL_B) { out.push(CTRL_B); continue; }
                out.push(CTRL_B, b);
                continue;
            }
            if (b === CTRL_B) { this.prefixed = true; continue; }
            out.push(b);
        }
        return { send: Buffer.from(out), detach: false };
    }
}

/** Modes a session may have left on the terminal, turned back off on leaving. */
const RESTORE = "\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\r\n";

export interface AttachIo {
    stdin: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
    stdout: NodeJS.WritableStream & { columns?: number; rows?: number; on(ev: "resize", fn: () => void): unknown; off?(ev: "resize", fn: () => void): unknown };
}

/** Why the attach ended: the user detached, the session ended, or the host refused or went away. */
export type AttachEnd = { reason: "detached" } | { reason: "exited"; code: number | null } | { reason: "closed" | "error"; message: string };

export function attachHost(socketPath: string, io: AttachIo, opts: { readonly?: boolean } = {}): Promise<AttachEnd> {
    const readonly = opts.readonly === true;
    return new Promise((resolve) => {
        const sock: Socket = connect(socketPath);
        const reader = new FrameReader();
        const keys = new DetachKeys();
        let done = false;
        const size = () => ({ rows: io.stdout.rows ?? 24, cols: io.stdout.columns ?? 80 });
        const onResize = () => sock.write(frame(FRAME.resize, JSON.stringify(size())));
        const onKeys = (chunk: Buffer | string) => {
            const r = keys.feed(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            if (r.send.length > 0 && !readonly) sock.write(frame(FRAME.input, r.send));
            if (r.detach) finish({ reason: "detached" });
        };
        const finish = (end: AttachEnd) => {
            if (done) return;
            done = true;
            io.stdin.off("data", onKeys);
            io.stdout.off?.("resize", onResize);
            if (io.stdin.isTTY) io.stdin.setRawMode?.(false);
            io.stdin.pause();
            io.stdout.write(RESTORE);
            sock.destroy();
            resolve(end);
        };
        sock.on("connect", () => {
            sock.write(frame(FRAME.hello, JSON.stringify({ version: 1, client: "claude-loop", mode: readonly ? "readonly" : "interactive", view: "stream", scrollback: 0, size: size() })));
            if (io.stdin.isTTY) io.stdin.setRawMode?.(true);
            io.stdin.on("data", onKeys);
            io.stdin.resume();
            if (!readonly) io.stdout.on("resize", onResize);
        });
        sock.on("data", (chunk: Buffer) => {
            for (const f of reader.push(chunk)) {
                if (f.type === FRAME.snapshot) {
                    // A fresh screen, then the host's repaint of it.
                    io.stdout.write("\x1b[H\x1b[2J");
                    io.stdout.write(f.payload.subarray(8));
                } else if (f.type === FRAME.output) {
                    io.stdout.write(f.payload.subarray(8));
                } else if (f.type === FRAME.exited) {
                    const e = JSON.parse(f.payload.toString("utf8")) as { code?: number | null; restarting?: boolean };
                    if (!e.restarting) finish({ reason: "exited", code: e.code ?? null });
                } else if (f.type === FRAME.closed || f.type === FRAME.error) {
                    const e = JSON.parse(f.payload.toString("utf8")) as { reason?: string; error?: string };
                    finish({ reason: f.type === FRAME.closed ? "closed" : "error", message: e.error ?? e.reason ?? "" });
                }
            }
        });
        sock.on("error", (e) => finish({ reason: "error", message: e.message }));
        sock.on("close", () => finish({ reason: "closed", message: "the host closed the connection" }));
    });
}
