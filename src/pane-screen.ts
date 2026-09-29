/**
 * #3128 — an agent's screen, for the web terminal (`agent.<id>.screen` on the
 * bus): wherever the agent's Claude runs, one stream of events.
 *
 * - **On the session host** (docs/LOOP-HOST.md): the daemon attaches to the
 *   host's socket as a `stream` client. The snapshot repaints the screen, then
 *   Claude's output flows as it comes; keys and size go back as frames, through
 *   the host's keystroke detection, so AFK stays right. `readonly` until the
 *   viewer unlocks typing: a viewer that only watches never takes the size.
 * - **In tmux** (a claude-loop started the tmux way): the `capture-pane`
 *   mirror, a whole frame each second, sent only when it changed.
 * - **On a proxy node**: the node runs the same mirror, relayed over its
 *   reverse connection.
 *
 * The events, one shape whatever the source:
 * `snapshot` / `output` (host: bytes, base64), `size` (host), `frame` (tmux
 * and node: a whole screen as text), `error` (passing), `unavailable` (the
 * screen cannot be followed: nothing more comes).
 */
import { connect, type Socket } from "node:net";
import { FRAME, FrameReader, frame } from "./claude-loop/host-attach.js";
import { captureOnce, MAX_KEYS_BYTES, paneTarget, resolveLoopName, sendLoopKeys, type PaneGeometry } from "./pane.js";
import { getConsumer } from "./db.js";
import { sessionFor } from "./sessions/registry.js";
import {
    getNodeSocketForConsumerIp,
    listConnectedNodeIds,
    newRequestId,
    registerResponseHandler,
    unregisterResponseHandler,
} from "./proxy-ws.js";
import { listNodes } from "./db/nodes.js";

export { MAX_KEYS_BYTES };

export interface Size { rows: number; cols: number }

export type ScreenEvent =
    | { kind: "snapshot"; data: string; size: Size | null }
    | { kind: "output"; data: string }
    | { kind: "size"; rows: number; cols: number }
    | { kind: "frame"; text: string; cursor: { x: number; y: number } | null; geometry: PaneGeometry | null; truncated: boolean; captured_at: string }
    | { kind: "error"; error: string }
    | { kind: "unavailable"; error: string };

export type ScreenSourceKind = "host" | "tmux" | "node";

export interface Screen {
    readonly source: ScreenSourceKind;
    /** Whether this viewer may type (host: an `interactive` client). */
    readonly typing: boolean;
    /** The viewer's keys, as typed or pasted. */
    keys(keys: string): Promise<void>;
    /** The size a typing viewer would like (host only; the others ignore it). */
    resize(size: Size): void;
    close(): void;
}

export interface OpenScreen {
    typing: boolean;
    size?: Size;
}

/** Where an agent's screen would come from, or why it cannot be followed. */
export function screenSourceOf(agent: string): ScreenSourceKind | { error: string } {
    if (sessionFor({ agent })?.running) return "host";
    const consumer = getConsumer(agent);
    if (!consumer) return { error: `no consumer ${agent}` };
    if (consumer.last_seen_via === "node") return "node";
    if (!consumer.cwd) return { error: "the agent has no loop running: no cwd yet" };
    if (!resolveLoopName(consumer.cwd, agent)) return { error: `no claude-loop runs in ${consumer.cwd}` };
    return "tmux";
}

/**
 * Follow `agent`'s screen: `emit` gets its events until `close()`. Null when
 * it cannot be followed; `emit` has had the `unavailable` saying why.
 */
export function openScreen(agent: string, opts: OpenScreen, emit: (e: ScreenEvent) => void): Screen | null {
    const where = screenSourceOf(agent);
    if (typeof where !== "string") {
        emit({ kind: "unavailable", error: where.error });
        return null;
    }
    if (where === "host") return hostScreen(agent, opts, emit);
    if (where === "node") return nodeScreen(agent, emit);
    return tmuxScreen(agent, emit);
}

// ---- on the session host ------------------------------------------------------

/** Claude writes in small pieces: what comes within this delay goes as one event. */
const OUTPUT_COALESCE_MS = 15;

function hostScreen(agent: string, opts: OpenScreen, emit: (e: ScreenEvent) => void): Screen | null {
    const link = sessionFor({ agent });
    if (!link) {
        emit({ kind: "unavailable", error: "the session is gone" });
        return null;
    }
    const sock: Socket = connect(link.attachSocket());
    const reader = new FrameReader();
    let size: Size | null = null;
    let pending: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ended = false;

    const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!pending.length) return;
        const data = Buffer.concat(pending).toString("base64");
        pending = [];
        emit({ kind: "output", data });
    };
    const end = (error: string) => {
        if (ended) return;
        ended = true;
        flush();
        emit({ kind: "unavailable", error });
        sock.destroy();
    };

    sock.on("connect", () => {
        sock.write(frame(FRAME.hello, JSON.stringify({
            version: 1,
            client: "web",
            mode: opts.typing ? "interactive" : "readonly",
            view: "stream",
            scrollback: 0,
            ...(opts.typing && opts.size ? { size: opts.size } : {}),
        })));
    });
    sock.on("data", (chunk: Buffer) => {
        for (const f of reader.push(chunk)) {
            if (f.type === FRAME.welcome) {
                size = sizeOf(JSON.parse(f.payload.toString("utf8")).size) ?? size;
            } else if (f.type === FRAME.snapshot) {
                pending = [];
                if (timer) clearTimeout(timer);
                timer = null;
                emit({ kind: "snapshot", data: f.payload.subarray(8).toString("base64"), size });
            } else if (f.type === FRAME.output) {
                pending.push(Buffer.from(f.payload.subarray(8)));
                timer ??= setTimeout(flush, OUTPUT_COALESCE_MS);
            } else if (f.type === FRAME.size) {
                flush();
                size = sizeOf(JSON.parse(f.payload.toString("utf8"))) ?? size;
                if (size) emit({ kind: "size", ...size });
            } else if (f.type === FRAME.exited) {
                // Restarting: a fresh snapshot follows once the new Claude draws.
                const p = JSON.parse(f.payload.toString("utf8")) as { restarting?: boolean };
                if (!p.restarting) end("Claude exited");
            } else if (f.type === FRAME.closed) {
                const p = JSON.parse(f.payload.toString("utf8") || "{}") as { reason?: string };
                end(p.reason ? `the session closed (${p.reason})` : "the session closed");
            } else if (f.type === FRAME.error) {
                const p = JSON.parse(f.payload.toString("utf8")) as { error?: string; code?: string };
                emit({ kind: "error", error: p.error ?? p.code ?? "the host refused" });
            }
        }
    });
    sock.on("error", (e) => end(`the host's socket: ${e.message}`));
    sock.on("close", () => end("the session closed"));

    return {
        source: "host",
        typing: opts.typing,
        keys: async (keys) => {
            if (!opts.typing) throw new Error("this screen was opened read-only");
            if (!ended) sock.write(frame(FRAME.input, Buffer.from(keys, "utf8")));
        },
        resize: (s) => {
            if (opts.typing && !ended) sock.write(frame(FRAME.resize, JSON.stringify(s)));
        },
        close: () => {
            ended = true;
            if (timer) clearTimeout(timer);
            sock.end();
        },
    };
}

function sizeOf(v: unknown): Size | null {
    const s = v as { rows?: unknown; cols?: unknown } | null;
    return s && typeof s.rows === "number" && typeof s.cols === "number" ? { rows: s.rows, cols: s.cols } : null;
}

// ---- in tmux ------------------------------------------------------------------

const POLL_INTERVAL_MS = 1000;

function tmuxScreen(agent: string, emit: (e: ScreenEvent) => void): Screen {
    let stopped = false;
    let last = "";
    let lastError = "";
    let busy = false;

    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const cwd = getConsumer(agent)?.cwd;
            const loop = cwd ? resolveLoopName(cwd, agent) : null;
            if (!loop) {
                if (lastError !== "gone") emit({ kind: "error", error: "the loop is not running" });
                lastError = "gone";
                return;
            }
            const r = await captureOnce(paneTarget(loop));
            if (stopped) return;
            if ("error" in r) {
                if (r.error !== lastError) emit({ kind: "error", error: r.error });
                lastError = r.error;
                return;
            }
            lastError = "";
            // A whole screen each time: send it only when it changed.
            const key = JSON.stringify([r.text, r.cursor, r.geometry]);
            if (key === last) return;
            last = key;
            emit({ kind: "frame", text: r.text, cursor: r.cursor ?? null, geometry: r.geometry ?? null, truncated: r.truncated, captured_at: r.captured_at });
        } finally {
            busy = false;
        }
    };
    void tick();
    const iv = setInterval(() => void tick(), POLL_INTERVAL_MS);

    return {
        source: "tmux",
        typing: true,
        keys: (keys) => tmuxKeys(agent, keys),
        resize: () => {},
        close: () => {
            stopped = true;
            clearInterval(iv);
        },
    };
}

/**
 * Keys into a tmux loop's pane. `send-keys` goes around the PTY proxy, which
 * would have told the loop a human is typing; the loop is told here instead,
 * so its wake gate does not run against the keys.
 */
async function tmuxKeys(agent: string, keys: string): Promise<void> {
    const cwd = getConsumer(agent)?.cwd;
    const loop = cwd ? resolveLoopName(cwd, agent) : null;
    if (!loop) throw new Error("the loop is not running");
    const r = await sendLoopKeys(loop, keys);
    if (!r.ok) throw new Error(r.error ?? "send-keys failed");
}

// ---- on a proxy node ------------------------------------------------------------

/** Why a node-relayed agent's node cannot be reached, for the viewer. */
function nodeUnreachable(lastSeenIp: string | null): string {
    const connected = listConnectedNodeIds();
    const node = listNodes().find((n) => n.last_seen_ip === lastSeenIp);
    if (connected.length === 0) return "no proxy node is connected to this daemon: restart the daemon on the node that runs this agent";
    if (!node) return `no node matches the agent's last address (${lastSeenIp ?? "none"}); connected: ${connected.join(", ")}`;
    return `node ${node.node_id} (${node.label}) is registered but not connected right now: restart the proxy daemon on it`;
}

function nodeScreen(agent: string, emit: (e: ScreenEvent) => void): Screen | null {
    const consumer = getConsumer(agent)!;
    const ws = getNodeSocketForConsumerIp(consumer.last_seen_ip ?? null);
    if (!ws) {
        emit({ kind: "unavailable", error: nodeUnreachable(consumer.last_seen_ip ?? null) });
        return null;
    }
    if (!consumer.cwd) {
        emit({ kind: "unavailable", error: "the agent has no loop running: no cwd yet" });
        return null;
    }
    const cwd = consumer.cwd;
    const requestId = newRequestId();
    let stopped = false;
    registerResponseHandler(requestId, (f) => {
        if (stopped) return;
        if (f.kind === "pane.frame") {
            emit({
                kind: "frame",
                text: String(f.text ?? ""),
                cursor: (f.cursor as { x: number; y: number } | null | undefined) ?? null,
                geometry: (f.geometry as PaneGeometry | null | undefined) ?? null,
                truncated: !!f.truncated,
                captured_at: String(f.captured_at ?? new Date().toISOString()),
            });
        } else if (f.kind === "pane.error") {
            emit({ kind: "error", error: String(f.error ?? "the node's capture failed") });
        }
    });
    try {
        ws.send(JSON.stringify({ kind: "pane.stream.open", request_id: requestId, consumer_id: agent, cwd }));
    } catch {
        unregisterResponseHandler(requestId);
        emit({ kind: "unavailable", error: "the node's connection failed" });
        return null;
    }
    return {
        source: "node",
        typing: true,
        keys: (keys) => nodeKeys(agent, keys),
        resize: () => {},
        close: () => {
            if (stopped) return;
            stopped = true;
            unregisterResponseHandler(requestId);
            try { ws.send(JSON.stringify({ kind: "pane.stream.close", request_id: requestId })); } catch { /* the node is gone */ }
        },
    };
}

/** Keys into a node-relayed agent's pane: one request, one acknowledgement. */
async function nodeKeys(agent: string, keys: string): Promise<void> {
    const consumer = getConsumer(agent);
    const ws = consumer ? getNodeSocketForConsumerIp(consumer.last_seen_ip ?? null) : undefined;
    if (!consumer || !ws) throw new Error(nodeUnreachable(consumer?.last_seen_ip ?? null));
    if (!consumer.cwd) throw new Error("the agent has no loop running: no cwd yet");
    const requestId = newRequestId();
    const ack = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
            unregisterResponseHandler(requestId);
            resolve({ ok: false, error: "the node did not acknowledge the keys" });
        }, 3000);
        registerResponseHandler(requestId, (f) => {
            if (f.kind !== "pane.ack") return;
            clearTimeout(timer);
            unregisterResponseHandler(requestId);
            resolve({ ok: !!f.ok, error: typeof f.error === "string" ? f.error : undefined });
        });
    });
    try {
        ws.send(JSON.stringify({ kind: "pane.keys", request_id: requestId, consumer_id: agent, cwd: consumer.cwd, keys }));
    } catch (e) {
        unregisterResponseHandler(requestId);
        throw new Error(`the node's connection failed: ${(e as Error).message}`);
    }
    const r = await ack;
    if (!r.ok) throw new Error(r.error ?? "the node refused the keys");
}

/** Keys into an agent's pane without an open screen: tmux and node loops only. */
export async function keysWithoutScreen(agent: string, keys: string): Promise<void> {
    const where = screenSourceOf(agent);
    if (typeof where !== "string") throw new Error(where.error);
    if (where === "host") throw new Error("a loop on the session host takes keys through an open screen with typing");
    if (where === "node") return nodeKeys(agent, keys);
    return tmuxKeys(agent, keys);
}
