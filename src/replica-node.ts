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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BusClient } from "./bus-client.js";
import { relayAuthorization, type ProxyConfig, type ProxyTokenStore } from "./proxy.js";
import { AIBALL_HOME } from "./paths.js";
import type { Document } from "./db/documents.js";
import type { DocKind } from "./db/doc-revs.js";
import { applyBoardTables, applyDocuments, keeps } from "./db/replica-apply.js";

interface ReplicaState {
    /** The master's last revision this node has looked at. */
    cursor: number;
    /** The board tables' signatures as last applied. */
    board: Record<string, string>;
    /** When the node last caught up with its master (ISO), null before. */
    synced_at: string | null;
}

const STATE_FILE = () => join(AIBALL_HOME, "replica.json");

export function readReplicaState(): ReplicaState {
    try {
        const s = JSON.parse(readFileSync(STATE_FILE(), "utf8")) as Partial<ReplicaState>;
        return { cursor: s.cursor ?? 0, board: s.board ?? {}, synced_at: s.synced_at ?? null };
    } catch {
        return { cursor: 0, board: {}, synced_at: null };
    }
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
    close(): void;
}

/** Documents asked for at once, as the master allows. */
const DOCS_BATCH = 100;
/** Headers asked for at once. */
const CHANGES_BATCH = 5000;

export function startReplicaNode(cfg: ProxyConfig, store: ProxyTokenStore): ReplicaNode {
    let client: BusClient | null = null;
    let syncing: Promise<void> | null = null;
    let again = false;
    const wanted = new Map<string, { kind: DocKind; key: string }>();
    let keepTimer: NodeJS.Timeout | null = null;

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
        try {
            return await (await bus()).call<T>(method, params);
        } catch (e) {
            client?.close();
            client = null;
            throw e;
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
            for (const h of got.changes) if (keeps(h.kind, h.key)) kept.set(`${h.kind}:${h.key}`, { kind: h.kind, key: h.key });
            await fetchDocs([...kept.values()]);
            const cursor = got.changes.length > 0 ? got.changes[got.changes.length - 1].rev : got.last;
            state = { cursor, board, synced_at: new Date().toISOString() };
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

    return {
        signal(last) {
            if (last > readReplicaState().cursor) void sync();
        },
        keep,
        sync,
        close() {
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
        const calls = Array.isArray(msg) ? msg : [msg];
        for (const c of calls) {
            const m = c as { method?: unknown; params?: { id?: unknown } };
            if (m?.method === "ticket.get" && typeof m.params?.id === "number") replica.keep("ticket", String(m.params.id));
        }
    };
}
