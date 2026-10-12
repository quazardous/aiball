/**
 * #3066 3a — what the loop kernel does to the terminal Claude runs in, behind
 * one interface: whether it is still there, what its screen shows, typing
 * into it, ending it. Today's terminal is tmux, with the PTY proxy in between;
 * the session host is the second implementation. The kernel names neither for
 * these: it holds a `TerminalPort`.
 */
import { spawnSync } from "node:child_process";
import { type Socket } from "node:net";
import { connectHost, controlAuthLine } from "../host-socket.js";
import { captureCursor, captureCursorSync } from "../pane.js";
import { injectRawBytes, injectWakePhrase, MUX_CMD } from "./state.js";
import { muxRun } from "./mux-async.js";
import { CL_ENV } from "./env-vars.js";
import { findPromptZone, promptInputEmpty } from "./pane-watchers/prompt-zone-watcher.js";

export interface ScreenSnapshot {
    text: string;
    /** 0-based, visible-screen relative; null when unknown. */
    cursor: { x: number; y: number } | null;
}

export interface TerminalPort {
    readonly kind: "tmux" | "host";
    /** Whether Claude's terminal is still there. */
    alive(): boolean;
    /** The visible screen; empty text when it cannot be read. Blocks on tmux: for a one-off process (a hook). */
    screen(): ScreenSnapshot;
    /** #3461 — `alive`, without holding the process while the multiplexer answers: the kernel's. */
    isAlive(): Promise<boolean>;
    /** #3461 — `screen`, without holding the process while the multiplexer answers: the kernel's. */
    readScreen(): Promise<ScreenSnapshot>;
    /** A wake phrase, then Enter, delivered as the loop's own (never a human's) keys. */
    /** `onEnter` runs right before each Enter (#3923: it may come seconds after
     *  the phrase), so the submit it causes still reads as the loop's own. */
    inject(phrase: string, onWillInject?: () => void, onEnter?: () => void): Promise<boolean>;
    /** Raw bytes to Claude: a key such as Esc, Enter or an arrow. */
    injectRaw(bytes: string): Promise<boolean>;
    /** End the terminal, and Claude with it; resolves once the request is out (#3235). */
    end(): Promise<void>;
}

/**
 * A spawn error on the liveness probe (the mux binary being replaced during
 * an upgrade, a brief PATH glitch) reads as "alive" this many times in a row
 * before the session is declared gone: the loop must not drop its presence
 * over a probe that did not run.
 */
const SPAWN_RETRY_LIMIT = 5;

/** The tmux session `session`, pane 0, with the PTY proxy under it. */
export function tmuxPort(opts: { session: string; stateDir: string | undefined; log: (msg: string) => void }): TerminalPort {
    const pane = `${opts.session}.0`;
    let consecutiveSpawnErr = 0;
    /** One liveness answer, from a probe that ran or not. */
    const judge = (r: { status: number | null; error?: Error }): boolean => {
        if (r.error) {
            consecutiveSpawnErr++;
            if (consecutiveSpawnErr <= SPAWN_RETRY_LIMIT) {
                opts.log(`tmux probe spawn error (${r.error.message}, streak ${consecutiveSpawnErr}/${SPAWN_RETRY_LIMIT}) — treating session as alive`);
                return true;
            }
            opts.log(`tmux probe spawn error persisting (${SPAWN_RETRY_LIMIT}× in a row) — declaring session gone`);
            return false;
        }
        consecutiveSpawnErr = 0;
        return r.status === 0;
    };
    return {
        kind: "tmux",
        alive: () => judge(spawnSync(MUX_CMD, ["has-session", "-t", opts.session], { stdio: "ignore" })),
        isAlive: async () => judge(await muxRun(["has-session", "-t", opts.session])),
        // The text and the cursor at once: two calls, side by side.
        async readScreen() {
            const [text, cursor] = await Promise.all([muxRun(["capture-pane", "-t", pane, "-p"]), captureCursor(pane)]);
            return { text: text.status === 0 ? text.stdout : "", cursor };
        },
        screen() {
            try {
                const r = spawnSync(MUX_CMD, ["capture-pane", "-t", pane, "-p"], { encoding: "utf8" });
                return { text: r.stdout ?? "", cursor: captureCursorSync(pane) };
            } catch {
                return { text: "", cursor: null };
            }
        },
        inject: (phrase, onWillInject) => injectWakePhrase(pane, phrase, onWillInject),
        injectRaw: (bytes) => injectRawBytes(opts.stateDir!, bytes),
        async end() {
            try { spawnSync(MUX_CMD, ["kill-session", "-t", opts.session], { stdio: "ignore" }); } catch { /* tmux already gone */ }
        },
    };
}

/**
 * #3066 3b — the session host (docs/SESSION-HOST.md), over its `control.sock`:
 * the screen is the latest one the host announced (`host.screen_changed`, at
 * most 4 a second), seeded by `host.screen` on connecting, so reading it costs
 * nothing; typing is `host.inject`, which never counts as a human's keys.
 */
/** `host.keys`: a client's keys meant something for the loop (docs/SESSION-HOST.md). */
export interface HostKeys {
    typing?: boolean;
    lone_esc?: boolean;
    afk_key?: boolean;
    reload?: boolean;
    now_ms?: number;
}

/**
 * The proxy events a `host.keys` stands for: the ones the tmux proxy emits for
 * the same verdict, so the kernel handles keys from either the same way.
 */
export function proxyEventsOfKeys(k: HostKeys): Record<string, unknown>[] {
    const now_ms = typeof k.now_ms === "number" ? k.now_ms : Date.now();
    const out: Record<string, unknown>[] = [];
    if (k.afk_key) out.push({ event: "keystroke", kind: "afk_key", now_ms });
    if (k.typing) {
        out.push({ event: "keystroke", kind: "typing", now_ms });
        out.push({ event: "marker", name: "touch_marker", now_ms });
    }
    if (k.lone_esc) out.push({ event: "keystroke", kind: "typing", now_ms });
    if (k.reload) out.push({ event: "reload", now_ms });
    return out;
}

/** #3923 — the waits of `typeAndSubmit`, in ms. */
export const SUBMIT_TIMING = { pollMs: 50, minGapMs: 200, landMaxMs: 3000, settleMs: 150, confirmMaxMs: 3000 };

/** Text sits in Claude's input box: the box is on screen and not empty. */
function promptHasInput(s: ScreenSnapshot): boolean {
    const zone = findPromptZone(s.text);
    if (!zone) return false;
    return !promptInputEmpty(s.text, s.cursor ? { cursorX: s.cursor.x, cursorY: s.cursor.y } : undefined, zone);
}

/**
 * #3923 — a wake phrase, then Enter, on a terminal whose screen is known.
 *
 * Enter used to follow the phrase after a blind 200 ms. When Claude is slow to
 * read the phrase (a busy footer of background agents, a loaded machine), it
 * reads both in one go, as a paste, and the Enter becomes a new line inside it:
 * the wake sits in the prompt, never sent. So Enter waits until the phrase
 * shows in the input box, and is sent once more when the box still holds text
 * after it. With no input box on screen (not Claude's prompt, or a dialog),
 * neither check can tell anything: the old 200 ms, one Enter.
 */
export async function typeAndSubmit(
    io: { inject(text: string): Promise<boolean>; screen(): ScreenSnapshot; log(msg: string): void; beforeEnter?(): void },
    phrase: string,
    t: typeof SUBMIT_TIMING = SUBMIT_TIMING,
): Promise<boolean> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const waitFor = async (cond: () => boolean, maxMs: number): Promise<boolean> => {
        for (const end = Date.now() + maxMs; Date.now() < end; await sleep(t.pollMs)) if (cond()) return true;
        return cond();
    };
    const boxShown = findPromptZone(io.screen().text) !== null;
    const start = Date.now();
    if (!(await io.inject(phrase))) return false;
    if (boxShown) {
        if (await waitFor(() => promptHasInput(io.screen()), t.landMaxMs)) await sleep(t.settleMs);
        else io.log(`submit: the phrase did not show in the prompt within ${t.landMaxMs} ms, Enter anyway`);
    }
    const enter = (): Promise<boolean> => {
        try { io.beforeEnter?.(); } catch { /* the caller's marker is best effort */ }
        return io.inject("\r");
    };
    const left = t.minGapMs - (Date.now() - start);
    if (left > 0) await sleep(left);
    if (!(await enter())) return false;
    if (!boxShown) return true;
    if (await waitFor(() => !promptHasInput(io.screen()), t.confirmMaxMs)) return true;
    io.log("submit retried: the prompt still held the phrase after Enter");
    if (!(await enter())) return false;
    if (!(await waitFor(() => !promptHasInput(io.screen()), t.confirmMaxMs))) io.log("submit unconfirmed: the prompt still holds the phrase after a second Enter");
    return true;
}

export function hostPort(opts: {
    controlSocket: string;
    log: (msg: string) => void;
    /** A human's keys through an attached client. */
    onKeys?: (keys: HostKeys) => void;
    /** The control connection came up, or went down. */
    onLink?: (up: boolean) => void;
}): TerminalPort & { ready: Promise<void>; close(): void } {
    let sock: Socket | null = null;
    let open = false;
    /** The connection failed or closed: the host is gone. Before it is up, it is not gone yet. */
    let lost = false;
    let exited = false;
    let latest: ScreenSnapshot = { text: "", cursor: null };
    let nextId = 1;
    const waiting = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();

    const call = (method: string, params: unknown = {}): Promise<unknown> => new Promise((resolve, reject) => {
        if (!sock || !open) { reject(new Error(`control.sock closed (${method})`)); return; }
        const id = nextId++;
        waiting.set(id, (r) => (r.error ? reject(new Error(r.error.message)) : resolve(r.result)));
        sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    const screenOf = (v: unknown): ScreenSnapshot => {
        const s = v as { text?: unknown; cursor?: { x?: unknown; y?: unknown } } | null;
        const c = s?.cursor;
        return {
            text: typeof s?.text === "string" ? s.text : "",
            cursor: c && typeof c.x === "number" && typeof c.y === "number" ? { x: c.x, y: c.y } : null,
        };
    };

    const ready = new Promise<void>((resolve, reject) => {
        const { socket: s, token } = connectHost(opts.controlSocket);
        sock = s;
        let buf = "";
        s.setEncoding("utf8");
        s.on("connect", () => {
            // #3425 — first, on a host with a token (Windows); nothing on Unix.
            const auth = controlAuthLine(token);
            if (auth) s.write(auth);
            open = true;
            opts.onLink?.(true);
            call("host.screen").then((v) => { latest = screenOf(v); resolve(); }, reject);
        });
        s.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const text = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!text.trim()) continue;
                let m: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
                try { m = JSON.parse(text); } catch { continue; }
                if (typeof m.id === "number") {
                    const done = waiting.get(m.id);
                    waiting.delete(m.id);
                    done?.(m);
                } else if (m.method === "host.screen_changed") {
                    latest = screenOf(m.params);
                } else if (m.method === "host.keys") {
                    opts.onKeys?.((m.params ?? {}) as HostKeys);
                } else if (m.method === "host.exited") {
                    exited = !(m.params as { restarting?: boolean } | undefined)?.restarting;
                }
            }
        });
        s.on("error", (e) => { opts.log(`host port: control.sock ${e.message}`); if (!open) { lost = true; reject(e); } });
        s.on("close", () => {
            if (open) opts.onLink?.(false);
            open = false;
            lost = true;
            for (const done of waiting.values()) done({ error: { message: "control.sock closed" } });
            waiting.clear();
        });
    });

    const inject = async (text: string): Promise<boolean> => {
        try { await call("host.inject", { text }); return true; } catch (e) { opts.log(`host port: inject failed: ${(e as Error).message}`); return false; }
    };

    return {
        kind: "host",
        ready,
        // The kernel's main loop asks at once, before the connection is up.
        alive: () => !lost && !exited,
        isAlive: async () => !lost && !exited,
        screen: () => latest,
        // Already here: the host pushes its screen.
        readScreen: async () => latest,
        async inject(phrase, onWillInject, onEnter) {
            try { onWillInject?.(); } catch { /* the caller's markers are best effort */ }
            // The phrase, then Enter on its own once Claude has read it, so it
            // does not take the burst for a paste (#3923).
            return typeAndSubmit({ inject, screen: () => latest, log: (m) => opts.log(`host port: ${m}`), beforeEnter: onEnter }, phrase);
        },
        injectRaw: (bytes) => inject(bytes),
        // #3235 — the host goes with Claude, as the tmux session does: `host.stop`
        // stopped Claude alone, and the host left behind made the loop read as
        // alive and a new start answer HOST_BUSY. The host removes its directory
        // as it goes, and the daemon forgets the session when its channel closes.
        async end() { await call("host.shutdown", {}).catch(() => { /* already gone */ }); },
        close() { sock?.end(); },
    };
}

/**
 * #3066 — the terminal for a process that is not the kernel (a hook): the
 * session host when `CL_HOST_CONTROL` is set in its environment, which Claude
 * passes down to its hooks, tmux otherwise. A host port is connected before it
 * is returned; `close` lets the process exit.
 */
export async function terminalFromEnv(opts: { session: string; stateDir: string | undefined; log: (msg: string) => void }): Promise<TerminalPort & { close(): void }> {
    const control = process.env[CL_ENV.HOST_CONTROL];
    if (control) {
        const port = hostPort({ controlSocket: control, log: opts.log });
        await port.ready.catch((e: Error) => opts.log(`host port: ${e.message}`));
        return port;
    }
    return { ...tmuxPort(opts), close() { /* nothing held */ } };
}
