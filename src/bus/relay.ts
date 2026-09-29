/**
 * #3071 — the bus on a proxy node: each local connection to `/bus` is relayed
 * to the upstream's `/bus`, one upstream connection each, opened with the same
 * identity rules as the node's `/api` relay (`relayAuthorization`). Messages
 * pass as they are, both ways; the node reads none of them. The upstream sees
 * the caller as relayed, and refuses it what nodes may not do.
 *
 * - The local connection is accepted only once the upstream one is open: the
 *   `bus.hello` a client gets is the upstream's, with its epoch.
 * - Either side closing closes the other: a client never keeps a connection
 *   whose subscriptions died upstream.
 * - #3284 — a call to a method that acts on the machine (`machine: true`: its
 *   loops, session hosts, folders, the daemon) is not relayed: the node runs
 *   it, for its own machine, as the caller the upstream's `bus.hello` named.
 *   Everything else, the board, passes as before, unread.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { BUS_PATH } from "../bus-protocol.js";
import { relayAuthorization, type ProxyConfig, type ProxyTokenStore } from "../proxy.js";
import { bearerFrom } from "../auth.js";
import { RPC_ERRORS } from "../bus-protocol.js";
import { ERROR_CODES } from "../domain.js";
import { getMethod, type Caller, type CallerKind } from "./methods.js";
import { dropSession, subjectSpecOf, type BusSession } from "./subscriptions.js";
import { runOne } from "./rpc.js";
import { isLoopback, isMachineSecret, looksLikeMachineSecret } from "../machine-secret.js";
// The table the node looks machine methods up in.
import "./register.js";

/** The request headers a relayed opening carries upstream: who, and what client. */
const FORWARDED = ["x-aiball-consumer", "x-aiball-platform", "x-aiball-client", "x-aiball-no-claim", "x-aiball-role"];

/** A close code the other side may be sent (1005/1006 are reserved: they say "none"). */
function sendable(code: number): number {
    return code === 1005 || code === 1006 || code < 1000 ? 1011 : code;
}

/** The method a request names, or null for a frame that is not one call. */
function methodOf(msg: unknown): string | null {
    const m = (msg as { method?: unknown } | null)?.method;
    return msg && typeof msg === "object" && !Array.isArray(msg) && typeof m === "string" ? m : null;
}

/**
 * #3294 — the subscriptions a node serves itself on one client connection:
 * their ids, so an unsubscribe goes where the subscription lives.
 */
export interface NodeSubs { ids: Set<string> }

const isMachine = (msg: unknown, subs?: NodeSubs): boolean => {
    const name = methodOf(msg);
    const params = ((msg as { params?: unknown }).params ?? {}) as { subject?: unknown; id?: unknown };
    // #3294 — a subscription to this machine's subject, and its end.
    if (name === "bus.subscribe") return typeof params.subject === "string" && subjectSpecOf(params.subject)?.machine === true;
    if (name === "bus.unsubscribe") return typeof params.id === "string" && subs?.ids.has(params.id) === true;
    const m = name === null ? undefined : getMethod(name);
    if (!m) return false;
    if (m.machine === true) return true;
    // #3293 — a loop control, for a loop that runs on this machine.
    if (!m.nodeLocal) return false;
    try { return m.nodeLocal((msg as { params?: unknown }).params ?? {}); } catch { return false; }
};

/**
 * #3284 — what the node does with a frame from its client: relay it (the
 * board), or answer it itself (a machine method). A batch goes one way whole;
 * one that mixes both is answered with an error per call, as its two halves
 * would answer on two frames.
 */
export async function nodeAnswer(text: string, caller: () => Promise<Caller>, subs?: NodeSubs): Promise<{ relay: true } | { relay: false; answer: string | null }> {
    let msg: unknown;
    try { msg = JSON.parse(text); } catch { return { relay: true }; }
    const local = (m: unknown) => isMachine(m, subs);
    const run = async (who: Caller, one: unknown) => {
        const r = await runOne(who, one);
        // #3294 — remember the subscriptions served here, forget the ended ones.
        const name = methodOf(one);
        const res = (r as { result?: { id?: unknown } } | null)?.result;
        if (subs && name === "bus.subscribe" && typeof res?.id === "string") subs.ids.add(res.id);
        if (subs && name === "bus.unsubscribe") subs.ids.delete(String(((one as { params?: { id?: unknown } }).params ?? {}).id));
        return r;
    };
    if (Array.isArray(msg)) {
        const machine = msg.filter(local).length;
        if (machine === 0) return { relay: true };
        if (machine < msg.length) {
            const id = (m: unknown) => (m as { id?: unknown } | null)?.id ?? null;
            return {
                relay: false,
                answer: JSON.stringify(msg.filter((m) => m && typeof m === "object" && "id" in (m as object)).map((m) => ({
                    jsonrpc: "2.0", id: id(m),
                    error: { code: RPC_ERRORS.INVALID_REQUEST, message: "a batch mixes this machine's methods with the board's: send them apart", data: { code: ERROR_CODES.BAD_REQUEST, status: 400 } },
                }))),
            };
        }
        const who = await caller();
        const out = [];
        for (const one of msg) {
            const r = await run(who, one);
            if (r) out.push(r);
        }
        return { relay: false, answer: out.length ? JSON.stringify(out) : null };
    }
    if (!local(msg)) return { relay: true };
    const r = await run(await caller(), msg);
    return { relay: false, answer: r ? JSON.stringify(r) : null };
}

/** The caller the upstream's hello names, as the node's local methods see it. */
export function callerOfHello(params: unknown, trusted: boolean, machineLocal: boolean = trusted): Caller {
    const p = (params ?? {}) as { consumer?: unknown; kind?: unknown };
    const kind: CallerKind = p.kind === "human" || p.kind === "agent" || p.kind === "key" ? p.kind : "agent";
    return {
        ...(typeof p.consumer === "string" && p.consumer ? { consumer_id: p.consumer } : {}),
        kind,
        token_kind: kind === "key" ? "signal" : "agent",
        transport: trusted ? "uds" : "tcp",
        token: null,
        relayed: false,
        node: true,
        // The socket, or the machine secret over the loopback: a caller of this machine.
        ...(machineLocal ? { machine: "local" } : {}),
    };
}

/**
 * The bearer a node relays upstream, and whether the caller is of this machine.
 * The machine secret proves a local caller of the node: checked here, and never
 * relayed — the hub does not know it, and the node vouches with its own token,
 * as for any caller without one.
 */
export function relayedBearer(bearer: string | null, peer: string | null | undefined): { ok: true; bearer: string | null; machineLocal: boolean } | { ok: false } {
    if (!bearer || !looksLikeMachineSecret(bearer)) return { ok: true, bearer, machineLocal: false };
    if (!isLoopback(peer) || !isMachineSecret(bearer)) return { ok: false };
    return { ok: true, bearer: null, machineLocal: true };
}

function refuse(socket: Duplex, status: number, body: string): void {
    socket.write(
        `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Gateway"}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.destroy();
}

export function attachBusRelay(server: Server, cfg: ProxyConfig, store: ProxyTokenStore, opts: { trusted?: boolean } = {}): WebSocketServer {
    const trusted = opts.trusted === true;
    const wss = new WebSocketServer({ noServer: true });
    const upstreamUrl = `${cfg.url.replace(/\/$/, "").replace(/^http/, "ws")}${BUS_PATH}`;
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (new URL(req.url ?? "/", "http://localhost").pathname !== BUS_PATH) return;
        const header = (name: string) => {
            const v = req.headers[name];
            return Array.isArray(v) ? v[0] : v;
        };
        const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        const given = relayedBearer(bearerFrom(header, query), req.socket?.remoteAddress);
        if (!given.ok) {
            refuse(socket, 401, JSON.stringify({ error: "invalid machine secret, or not from this machine", code: "TOKEN_INVALID" }));
            return;
        }
        const machineLocal = trusted || given.machineLocal;
        const bearer = given.bearer;
        const auth = relayAuthorization(cfg, store, bearer ? `Bearer ${bearer}` : undefined);
        if (!auth.ok) {
            refuse(socket, 401, JSON.stringify({ error: auth.error, code: "AUTH_REQUIRED" }));
            return;
        }
        const headers: Record<string, string> = {};
        if (auth.authorization) headers.authorization = auth.authorization;
        if (cfg.nodeLabel) headers["x-aiball-node-label"] = cfg.nodeLabel;
        for (const h of FORWARDED) {
            const v = header(h);
            if (typeof v === "string" && v) headers[h] = v;
        }
        const up = new WebSocket(upstreamUrl, { headers });
        up.once("unexpected-response", (_r, res) => {
            let body = "";
            res.on("data", (d: Buffer) => { body += d.toString(); });
            res.on("end", () => refuse(socket, res.statusCode ?? 502, body || JSON.stringify({ error: "the upstream refused" })));
        });
        up.once("error", (e) => {
            if (up.readyState !== WebSocket.OPEN) refuse(socket, 502, JSON.stringify({ error: `proxy upstream unreachable: ${e.message}`, code: "BAD_GATEWAY" }));
        });
        up.once("open", () => {
            // Accepted in this same tick (no verifyClient: handleUpgrade calls
            // back synchronously), so the upstream's first message, its hello,
            // cannot arrive before the relay below is in place.
            wss.handleUpgrade(req, socket, head, (local) => {
                // #3294 — the subscriptions the node serves itself: their events go to this client.
                const session: BusSession = {
                    subscriptions: new Map(),
                    notify(method, params) {
                        if (local.readyState === WebSocket.OPEN) local.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
                    },
                };
                const subs: NodeSubs = { ids: new Set() };
                local.on("close", () => dropSession(session));
                // #3284 — who the upstream says the caller is: its hello, the first frame.
                let hello: (c: Caller) => void = () => {};
                const helloCaller = new Promise<Caller>((resolve) => { hello = (c) => resolve({ ...c, session }); });
                let greeted = false;
                up.on("message", (data, binary) => {
                    if (!greeted && !binary) {
                        try {
                            const m = JSON.parse(data.toString()) as { method?: unknown; params?: unknown };
                            if (m.method === "bus.hello") { greeted = true; hello(callerOfHello(m.params, trusted, machineLocal)); }
                        } catch { /* not JSON: relayed as it is */ }
                    }
                    if (local.readyState === WebSocket.OPEN) local.send(data, { binary });
                });
                // In order, as the core answers one connection's calls.
                let queue = Promise.resolve();
                local.on("message", (data, binary) => {
                    if (binary) {
                        if (up.readyState === WebSocket.OPEN) up.send(data, { binary });
                        return;
                    }
                    const text = data.toString();
                    queue = queue.then(async () => {
                        const d = await nodeAnswer(text, () => helloCaller, subs);
                        if (d.relay) {
                            if (up.readyState === WebSocket.OPEN) up.send(text);
                        } else if (d.answer !== null && local.readyState === WebSocket.OPEN) {
                            local.send(d.answer);
                        }
                    }).catch(() => { /* one frame's failure never stops the relay */ });
                });
                up.on("close", (code, reason) => {
                    if (local.readyState === WebSocket.OPEN) local.close(sendable(code), reason);
                });
                local.on("close", (code, reason) => {
                    if (up.readyState === WebSocket.OPEN) up.close(sendable(code), reason);
                });
                up.on("error", () => local.terminate());
                local.on("error", () => up.terminate());
            });
        });
    });
    return wss;
}
