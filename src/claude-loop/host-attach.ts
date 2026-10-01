/**
 * #3066 — `claude-loop attach` for a loop on the daemon's session host: a
 * terminal client of the host's attach socket (docs/LOOP-HOST.md, view
 * `stream`). The screen is repainted from the host's snapshot, then Claude's
 * output flows; the keys typed and the terminal's size go to the session, and
 * the host's keystroke detection (AFK) sees them as it sees tmux's.
 *
 * Detach with Ctrl-B D, as in tmux; Ctrl-B Ctrl-B sends one Ctrl-B. Leaving
 * stops nothing: Claude carries on on the host. #3166 — `readonly` watches a
 * copy: the keys go nowhere and the size stays the other clients'; Ctrl-C or
 * Ctrl-D leaves it too, as Ctrl-B D does (they would reach nothing anyway).
 */
import { attachBarRow, RESET_SCROLL_REGION, scrollRegion, type AttachBarSetup, type AttachBarView } from "./attach-bar.js";
import { connectHost, withToken } from "../host-socket.js";

export const FRAME = {
    hello: 0x01, welcome: 0x02, snapshot: 0x03, output: 0x04, input: 0x05, resize: 0x06,
    size: 0x08, exited: 0x0a, closed: 0x0b, error: 0x0c,
    // #3474 — a client with the controls closes every other attach.
    detach_others: 0x0f, detached_others: 0x10,
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

/**
 * #3166 — the bar a read-only copy shows on its terminal's last row, in reverse
 * video: saved cursor, the bar, cursor back, so Claude's screen is untouched
 * where it does not reach that row. Cut to the width; an emoji counts two.
 */
export function copyBar(rows: number, cols: number, label: string): string {
    const text = ` 👁 COPY · read-only · ${label} · Ctrl-C or Ctrl-B D to leave · --force for the controls `;
    let cells = 0;
    let out = "";
    for (const ch of text) {
        const w = /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
        if (cells + w > cols) break;
        out += ch;
        cells += w;
    }
    return `\x1b7\x1b[${rows};1H\x1b[0;7m${out}${" ".repeat(Math.max(0, cols - cells))}\x1b[0m\x1b8`;
}

/** Modes a session may have left on the terminal, turned back off on leaving. */
const RESTORE = "\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\r\n";

export interface AttachIo {
    stdin: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
    stdout: NodeJS.WritableStream & { columns?: number; rows?: number; on(ev: "resize", fn: () => void): unknown; off?(ev: "resize", fn: () => void): unknown };
}

/** Why the attach ended: the user detached, the session ended, or the host refused or went away. */
export type AttachEnd = { reason: "detached" } | { reason: "exited"; code: number | null } | { reason: "closed" | "error"; message: string };

/** #3469 — hear the loop's bar: `onBar` at once with the current one, then on each change; returns how to stop. */
export type WatchBar = (onBar: (view: AttachBarView | null) => void) => () => void;

export function attachHost(socketPath: string, io: AttachIo, opts: { readonly?: boolean; label?: string; watchBar?: WatchBar; barSetup?: Omit<AttachBarSetup, "readonly">; now?: () => number } = {}): Promise<AttachEnd> {
    const readonly = opts.readonly === true;
    const label = opts.label ?? "the session";
    const now = opts.now ?? Date.now;
    // #3469 — with the loop's bar: drawn on the last row, Claude kept above it.
    const withBar = opts.watchBar !== undefined && opts.barSetup !== undefined;
    let barView: AttachBarView | null = null;
    // #3166 — a copy says so: the bar on the last row, drawn again after
    // whatever Claude writes, and the terminal's title (pushed, popped on leaving).
    const bar = () => {
        const rows = io.stdout.rows || 24;
        const cols = io.stdout.columns || 80;
        if (withBar) io.stdout.write(attachBarRow(rows, cols, barView, now(), { ...opts.barSetup!, readonly }));
        else if (readonly) io.stdout.write(copyBar(rows, cols, label));
    };
    const keepAbove = () => { if (withBar) io.stdout.write(scrollRegion(io.stdout.rows || 24)); };
    return new Promise((resolve) => {
        const { socket: sock, token } = connectHost(socketPath);
        const reader = new FrameReader();
        const keys = new DetachKeys();
        let done = false;
        // #3469 — Claude gets the rows above the bar.
        const size = () => ({ rows: Math.max(1, (io.stdout.rows || 24) - (withBar ? 1 : 0)), cols: io.stdout.columns || 80 });
        let stopBar: (() => void) | null = null;
        let tick: ReturnType<typeof setInterval> | null = null;
        const onBarResize = () => { keepAbove(); bar(); };
        const onResize = () => sock.write(frame(FRAME.resize, JSON.stringify(size())));
        const onKeys = (chunk: Buffer | string) => {
            const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            if (readonly && (buf.includes(0x03) || buf.includes(0x04))) return finish({ reason: "detached" });
            const r = keys.feed(buf);
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
            io.stdout.off?.("resize", bar);
            io.stdout.off?.("resize", onBarResize);
            stopBar?.();
            if (tick) clearInterval(tick);
            if (withBar) io.stdout.write(RESET_SCROLL_REGION);
            io.stdout.write(RESTORE);
            if (readonly) io.stdout.write("\x1b[23;0t");
            sock.destroy();
            resolve(end);
        };
        sock.on("connect", () => {
            sock.write(frame(FRAME.hello, JSON.stringify(withToken({ version: 1, client: "claude-loop", mode: readonly ? "readonly" : "interactive", view: "stream", scrollback: 0, size: size() }, token))));
            if (io.stdin.isTTY) io.stdin.setRawMode?.(true);
            io.stdin.on("data", onKeys);
            io.stdin.resume();
            if (!readonly) io.stdout.on("resize", onResize);
            if (readonly) io.stdout.write(`\x1b[22;0t\x1b]0;👁 COPY — ${label}\x07`);
            if (withBar) {
                keepAbove();
                io.stdout.on("resize", onBarResize);
                stopBar = opts.watchBar!((v) => { barView = v; bar(); });
                // The countdowns move by themselves.
                tick = setInterval(bar, 1000);
                tick.unref?.();
            } else if (readonly) {
                io.stdout.on("resize", bar);
            }
        });
        sock.on("data", (chunk: Buffer) => {
            for (const f of reader.push(chunk)) {
                if (f.type === FRAME.snapshot) {
                    // A fresh screen, then the host's repaint of it.
                    io.stdout.write("\x1b[H\x1b[2J");
                    io.stdout.write(f.payload.subarray(8));
                    bar();
                } else if (f.type === FRAME.output) {
                    io.stdout.write(f.payload.subarray(8));
                    bar();
                } else if (f.type === FRAME.exited) {
                    const e = JSON.parse(f.payload.toString("utf8")) as { code?: number | null; restarting?: boolean };
                    if (!e.restarting) finish({ reason: "exited", code: e.code ?? null });
                } else if (f.type === FRAME.closed || f.type === FRAME.error) {
                    const e = JSON.parse(f.payload.toString("utf8")) as { reason?: string; error?: string };
                    // #3474 — another client with the controls closed this one: said plainly.
                    const why = e.reason === "detached_by_other" ? "detached by another client" : e.error ?? e.reason ?? "";
                    finish({ reason: f.type === FRAME.closed ? "closed" : "error", message: why });
                }
            }
        });
        sock.on("error", (e) => finish({ reason: "error", message: e.message }));
        sock.on("close", () => finish({ reason: "closed", message: "the host closed the connection" }));
    });
}
