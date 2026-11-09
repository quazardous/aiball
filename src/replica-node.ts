/**
 * #4867 — a proxy node's copy of the board: lazy, ticket by ticket.
 *
 * The node stays a proxy: its clients' calls are relayed to the master as
 * before. Beside that, it keeps in its own database the documents that concern
 * it (`src/db/documents.ts`): a ticket enters when the node relays a read of
 * it, and with it come the board's small tables. Each time the master says its
 * last revision moved (`replica_rev`), the node asks what changed since its
 * cursor (headers only) and takes again the documents it keeps, and no other.
 *
 * Talks to the master over its bus, with the node's token, as the spool's
 * replay does. Its cursor and the board signatures it applied live in
 * `$AIBALL_HOME/replica.json`, not in the database: the board tables it
 * copies (`settings` among them) are replaced whole.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BusClient } from "./bus-client.js";
import { relayAuthorization, type ProxyConfig, type ProxyTokenStore } from "./proxy.js";
import { AIBALL_HOME } from "./paths.js";
import type { Document } from "./db/documents.js";
import type { DocKind } from "./db/doc-revs.js";
import { applyBoardTables, applyDocuments, keeps } from "./db/replica-apply.js";
import { getRawSqlite } from "./db/connection.js";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { authenticateUpgrade, openGated, type BusGate } from "./bus/server.js";
import { callerOf, getMethod } from "./bus/methods.js";
import { ERROR_CODES } from "./domain.js";
import { BOARD_READS } from "./replica-reads.js";

interface ReplicaState {
    /** The master's last revision this node has looked at. */
    cursor: number;
    /** The board tables' signatures as last applied. */
    board: Record<string, string>;
    /** When the node last caught up with its master (ISO), null before. */
    synced_at: string | null;
    /** The background replication reached every document: from then on, every change is taken. */
    complete: boolean;
}

const STATE_FILE = () => join(AIBALL_HOME, "replica.json");

export function readReplicaState(): ReplicaState {
    try {
        const s = JSON.parse(readFileSync(STATE_FILE(), "utf8")) as Partial<ReplicaState>;
        return { cursor: s.cursor ?? 0, board: s.board ?? {}, synced_at: s.synced_at ?? null, complete: s.complete === true };
    } catch {
        return { cursor: 0, board: {}, synced_at: null, complete: false };
    }
}

/** #4868 — a master that became a node: its database is a complete copy, level with `cursor`. */
export function markReplicaComplete(cursor: number, board: Record<string, string>): void {
    writeReplicaState({ cursor, board, synced_at: new Date().toISOString(), complete: true });
}

/** #4868 — a node that became master keeps no copy state. */
export function forgetReplicaState(): void {
    rmSync(STATE_FILE(), { force: true });
}

function writeReplicaState(s: ReplicaState): void {
    const tmp = `${STATE_FILE()}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, STATE_FILE());
}

type Header = { kind: DocKind; key: string; rev: number; project: string | null };

export interface ReplicaNode {
    /** The master says its last revision is `last`: catch up if behind. */
    signal(last: number): void;
    /** Keep this document from now on (a read the node relayed named it). */
    keep(kind: DocKind, key: string): void;
    /** Catch up now; resolves when level, or when the master is out of reach. */
    sync(): Promise<void>;
    /** The node's clients are at work: the background replication steps aside a while. */
    busy(): void;
    /** Where the copy stands: documents kept out of the master's, and whether it is complete. */
    progress(): ReplicaProgress;
    /** #4868 — call the master, as this node (its token). */
    call<T>(method: string, params: unknown): Promise<T>;
    close(): void;
}

export interface ReplicaProgress {
    kept: number;
    /** The master's documents, as last counted (null before a background pass). */
    total: number | null;
    complete: boolean;
    cursor: number;
    synced_at: string | null;
}

/** A sync that failed is tried again after this long, if no signal came first. */
const SYNC_RETRY_MS = 15_000;

/** The background pass steps aside this long after the node's clients were last at work. */
const BUSY_QUIET_MS = 5_000;

/** On battery, the background pass waits (Linux: a battery discharging). */
export function onBattery(): boolean {
    try {
        for (const d of readdirSync("/sys/class/power_supply")) {
            const status = join("/sys/class/power_supply", d, "status");
            if (existsSync(status) && readFileSync(status, "utf8").trim() === "Discharging") return true;
        }
    } catch { /* no such place: not a laptop, or not Linux */ }
    return false;
}

/**
 * #4867 — the order the background pass takes documents in: the consumers, the
 * tickets of the projects the node already keeps tickets of, then the rest; the
 * most recently revised first in each.
 */
export function backfillOrder(headers: readonly Header[], served: ReadonlySet<string>): Header[] {
    const rank = (h: Header) => (h.kind === "consumer" ? 0 : h.project !== null && served.has(h.project) ? 1 : 2);
    return [...headers].sort((a, b) => rank(a) - rank(b) || b.rev - a.rev);
}

/** Documents asked for at once, as the master allows. */
const DOCS_BATCH = 100;
/** Headers asked for at once. */
const CHANGES_BATCH = 5000;

let current: ReplicaNode | null = null;

/** #4867 — where this node's copy stands, or null when this daemon keeps none (not a proxy node). */
export function replicaProgress(): ReplicaProgress | null {
    return current ? current.progress() : null;
}

/** #4868 — this daemon's copy, when it is a proxy node. */
export function replicaNode(): ReplicaNode | null {
    return current;
}

export function startReplicaNode(cfg: ProxyConfig, store: ProxyTokenStore): ReplicaNode {
    const node = makeReplicaNode(cfg, store);
    current = node;
    return node;
}

function makeReplicaNode(cfg: ProxyConfig, store: ProxyTokenStore): ReplicaNode {
    let client: BusClient | null = null;
    let syncing: Promise<void> | null = null;
    let again = false;
    const wanted = new Map<string, { kind: DocKind; key: string }>();
    let keepTimer: NodeJS.Timeout | null = null;
    let busyAt = 0;
    let total: number | null = null;
    let stopped = false;
    let backfilling = false;
    let retryTimer: NodeJS.Timeout | null = null;
    const background = cfg.replica ?? { background: true, batch: 20, pauseMs: 2000 };

    async function bus(): Promise<BusClient> {
        if (client) return client;
        const auth = relayAuthorization(cfg, store, undefined);
        if (!auth.ok || !auth.authorization) throw new Error("strict mode: the node lends no token, it keeps no copy");
        const headers: Record<string, string> = { authorization: auth.authorization };
        if (cfg.nodeLabel) headers["x-aiball-node-label"] = cfg.nodeLabel;
        const c = await BusClient.connect({ url: cfg.url, headers, unrefWhenIdle: true });
        client = c;
        return c;
    }

    async function call<T>(method: string, params: unknown): Promise<T> {
        // A connection left from before a cut is dead: one more try, on a fresh one.
        for (let attempt = 0; ; attempt++) {
            try {
                return await (await bus()).call<T>(method, params);
            } catch (e) {
                client?.close();
                client = null;
                const status = (e as { status?: number }).status;
                if (attempt > 0 || (typeof status === "number" && status < 500)) throw e;
            }
        }
    }

    async function fetchDocs(keys: Array<{ kind: DocKind; key: string }>): Promise<void> {
        for (let i = 0; i < keys.length; i += DOCS_BATCH) {
            const got = await call<{ documents: Document[] }>("replica.docs", { keys: keys.slice(i, i + DOCS_BATCH) });
            applyDocuments(got.documents);
        }
    }

    async function syncBoard(signatures: Record<string, string>): Promise<Record<string, string>> {
        const state = readReplicaState();
        const moved = Object.keys(signatures).filter((t) => state.board[t] !== signatures[t]);
        if (moved.length === 0) return state.board;
        const got = await call<{ signatures: Record<string, string>; rows: Record<string, Array<Record<string, unknown>>> }>("replica.board", { tables: moved });
        applyBoardTables(got.rows);
        return { ...state.board, ...Object.fromEntries(moved.map((t) => [t, got.signatures[t]])) };
    }

    async function syncOnce(): Promise<void> {
        let state = readReplicaState();
        for (;;) {
            const got = await call<{ last: number; changes: Header[]; board: Record<string, string> }>("replica.changes", { after: state.cursor, limit: CHANGES_BATCH });
            const board = await syncBoard(got.board);
            // The documents this node keeps, at their newest revision in this batch.
            const kept = new Map<string, { kind: DocKind; key: string }>();
            for (const h of got.changes) {
                // Complete, the node takes every change; before, only what it keeps.
                if (state.complete || keeps(h.kind, h.key)) kept.set(`${h.kind}:${h.key}`, { kind: h.kind, key: h.key });
            }
            await fetchDocs([...kept.values()]);
            const cursor = got.changes.length > 0 ? got.changes[got.changes.length - 1].rev : got.last;
            state = { ...readReplicaState(), cursor, board, synced_at: new Date().toISOString() };
            writeReplicaState(state);
            if (got.changes.length < CHANGES_BATCH) return;
        }
    }

    function sync(): Promise<void> {
        if (syncing) { again = true; return syncing; }
        syncing = (async () => {
            try {
                do { again = false; await syncOnce(); } while (again);
            } catch (e) {
                console.warn(`[replica] sync stopped: ${(e as Error).message}`);
                // The master's next signal starts it again; this, in case none comes.
                if (!stopped && !retryTimer) {
                    retryTimer = setTimeout(() => { retryTimer = null; void sync(); }, SYNC_RETRY_MS);
                    retryTimer.unref?.();
                }
            } finally {
                syncing = null;
            }
        })();
        return syncing;
    }

    function keep(kind: DocKind, key: string): void {
        if (keeps(kind, key)) return;
        wanted.set(`${kind}:${key}`, { kind, key });
        if (keepTimer) return;
        // Gathered for a moment, fetched together, after the relayed read.
        keepTimer = setTimeout(() => {
            keepTimer = null;
            const keys = [...wanted.values()];
            wanted.clear();
            void fetchDocs(keys).catch((e) => console.warn(`[replica] keep failed: ${(e as Error).message}`));
        }, 250);
        keepTimer.unref?.();
    }

    const rest = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });

    /** One background pass: every document of the master the node lacks, a batch at a time, quietly. */
    async function backfill(): Promise<void> {
        if (backfilling || !background.background) return;
        backfilling = true;
        try {
            await sync();
            const headers: Header[] = [];
            for (let after = 0; ;) {
                const got = await call<{ changes: Header[] }>("replica.changes", { after, limit: CHANGES_BATCH });
                headers.push(...got.changes);
                if (got.changes.length < CHANGES_BATCH) break;
                after = got.changes[got.changes.length - 1].rev;
            }
            total = headers.length;
            const served = new Set(headers.filter((h) => h.kind === "ticket" && h.project !== null && keeps("ticket", h.key)).map((h) => h.project!));
            const todo = backfillOrder(headers, served).filter((h) => !keeps(h.kind, h.key));
            for (let i = 0; i < todo.length && !stopped; ) {
                // Quietly: never while the node's clients are at work, nor on battery.
                if (Date.now() - busyAt < BUSY_QUIET_MS || onBattery()) { await rest(Math.max(background.pauseMs, 1_000)); continue; }
                await fetchDocs(todo.slice(i, i + background.batch).map((h) => ({ kind: h.kind, key: h.key })));
                i += background.batch;
                await rest(background.pauseMs);
            }
            if (!stopped) {
                writeReplicaState({ ...readReplicaState(), complete: true });
                console.log(`[replica] complete: ${total} documents`);
                await sync();
            }
        } catch (e) {
            console.warn(`[replica] background pass stopped: ${(e as Error).message}`);
        } finally {
            backfilling = false;
        }
    }

    function countKept(): number {
        const db = getRawSqlite();
        const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
        return n(`SELECT count(*) AS n FROM tickets`) + n(`SELECT count(*) AS n FROM consumers`);
    }

    return {
        call,
        busy() { busyAt = Date.now(); },
        progress() {
            const st = readReplicaState();
            return { kept: countKept(), total, complete: st.complete, cursor: st.cursor, synced_at: st.synced_at };
        },
        signal(last) {
            if (last > readReplicaState().cursor) void sync();
            // The first signal of a connection starts the background pass, until complete.
            if (!readReplicaState().complete) void backfill();
        },
        keep,
        sync,
        close() {
            stopped = true;
            if (retryTimer) clearTimeout(retryTimer);
            client?.close();
            client = null;
            if (keepTimer) clearTimeout(keepTimer);
        },
    };
}

/** Whether this node has ever caught up with its master. */
export function replicaStarted(): boolean {
    return existsSync(STATE_FILE());
}

/**
 * #4867 — the reads a node relays that name a ticket: it keeps that ticket.
 * `ticket.get` by its id; more reads can join this list as they prove useful.
 */
export function keepWhatIsRead(replica: ReplicaNode): (msg: unknown) => void {
    return (msg) => {
        replica.busy();
        const calls = Array.isArray(msg) ? msg : [msg];
        for (const c of calls) {
            const m = c as { method?: unknown; params?: { id?: unknown } };
            if (m?.method === "ticket.get" && typeof m.params?.id === "number") replica.keep("ticket", String(m.params.id));
        }
    };
}

/** #4867 — the reads a node answers from its copy while cut (`src/replica-reads.ts`). */
export const CUT_READS = BOARD_READS;

/**
 * #4867 — the node's bus while cut: a connection its client opens is served
 * here, on the node's copy, through a gate that lets the reads above and the
 * node's own machine methods through, and refuses the rest as unavailable.
 * Only once the node holds a copy: before, the client gets the 502 it got.
 */
export function serveWhenCut(replica: ReplicaNode): (req: IncomingMessage, socket: Duplex, head: Buffer, trusted: boolean) => boolean {
    const wss = new WebSocketServer({ noServer: true });
    return (req, socket, head, trusted) => {
        const p = replica.progress();
        if (p.kept === 0) return false;
        const out = authenticateUpgrade(req, trusted);
        if (!out.ok) return false;
        const gate: BusGate = {
            refuse(method) {
                if (CUT_READS.has(method) || getMethod(method)?.machine === true) return null;
                return { message: "the master is out of reach: this node answers reads from its copy, and the write waits for the master", code: ERROR_CODES.UNAVAILABLE, status: 503 };
            },
            hello: { replica: { cut: true, complete: p.complete, as_of: p.synced_at } },
        };
        wss.handleUpgrade(req, socket, head, (ws) => openGated(ws, callerOf(out.ctx), gate));
        return true;
    };
}
