/**
 * #3066 3a — what the loop kernel does to the terminal Claude runs in, behind
 * one interface: whether it is still there, what its screen shows, typing
 * into it, ending it. Today's terminal is tmux, with the PTY proxy in between;
 * the session host is the second implementation. The kernel names neither for
 * these: it holds a `TerminalPort`.
 */
import { spawnSync } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { captureCursorSync } from "../pane.js";
import { injectRawBytes, injectWakePhrase, MUX_CMD } from "./state.js";

export interface ScreenSnapshot {
    text: string;
    /** 0-based, visible-screen relative; null when unknown. */
    cursor: { x: number; y: number } | null;
}

export interface TerminalPort {
    readonly kind: "tmux" | "host";
    /** Whether Claude's terminal is still there. */
    alive(): boolean;
    /** The visible screen; empty text when it cannot be read. */
    screen(): ScreenSnapshot;
    /** A wake phrase, then Enter, delivered as the loop's own (never a human's) keys. */
    inject(phrase: string, onWillInject?: () => void): Promise<boolean>;
    /** Raw bytes to Claude: a key such as Esc, Enter or an arrow. */
    injectRaw(bytes: string): Promise<boolean>;
    /** End the terminal, and Claude with it. */
    end(): void;
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
    return {
        kind: "tmux",
        alive() {
            const r = spawnSync(MUX_CMD, ["has-session", "-t", opts.session], { stdio: "ignore" });
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
        end() {
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
export function hostPort(opts: { controlSocket: string; log: (msg: string) => void }): TerminalPort & { ready: Promise<void>; close(): void } {
    let sock: Socket | null = null;
    let open = false;
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
        const s = createConnection(opts.controlSocket);
        sock = s;
        let buf = "";
        s.setEncoding("utf8");
        s.on("connect", () => {
            open = true;
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
                } else if (m.method === "host.exited") {
                    exited = !(m.params as { restarting?: boolean } | undefined)?.restarting;
                }
            }
        });
        s.on("error", (e) => { opts.log(`host port: control.sock ${e.message}`); if (!open) reject(e); });
        s.on("close", () => {
            open = false;
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
        alive: () => open && !exited,
        screen: () => latest,
        async inject(phrase, onWillInject) {
            try { onWillInject?.(); } catch { /* the caller's markers are best effort */ }
            // As over loop.sock: the phrase, then Enter on its own after 200 ms,
            // so Claude does not take the burst for a paste.
            if (!(await inject(phrase))) return false;
            await new Promise<void>((r) => setTimeout(r, 200));
            return inject("\r");
        },
        injectRaw: (bytes) => inject(bytes),
        end() { void call("host.stop", {}).catch(() => { /* already gone */ }); },
        close() { sock?.end(); },
    };
}
