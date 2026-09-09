/**
 * Benchmark the two surfaces an agent and the UI actually go through: the HTTP
 * API over the Unix socket, and the MCP boundary.
 *
 * Why both, and why they differ: an MCP call is the API call PLUS the JSON-RPC
 * round-trip, the `_status` counters stamped onto every response, and the
 * serialisation of a much larger payload. Measuring only the route hides the
 * half the agent actually waits for; measuring only MCP hides where the time
 * went. So each row of the API table has its MCP counterpart below it.
 *
 * Method, stated so a number can be argued with:
 *  - WARMUP runs are discarded. The first read of a cold cache is a different
 *    question from steady state, and mixing them produces a mean that
 *    describes neither.
 *  - The reported figure is the MEDIAN of N runs, with min and p90 beside it.
 *    A single-threaded daemon queues, so the tail is real and worth seeing —
 *    an earlier bench on this board spread 372-782 ms on the same call.
 *  - Requests are SEQUENTIAL. Running them in parallel against a daemon that
 *    serves one at a time measures the queue, not the work.
 *
 * Usage:  npx tsx scripts/bench-surfaces.ts [--runs 9] [--warmup 3] [--api-only]
 */
import { request } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const RUNS = Number(argOf("runs", "9"));
const WARMUP = Number(argOf("warmup", "3"));
const API_ONLY = argv.includes("--api-only");
const CONSUMER = argOf("consumer", "claude-aiball-dev");
const PROJECT = argOf("project", "aiball");

const home = process.env.AIBALL_HOME ?? join(homedir(), ".local/share/aiball");
const SOCK = process.env.AIBALL_SOCK || join(home, "sock");
if (!existsSync(SOCK)) {
    console.error(`no socket at ${SOCK} — is the daemon up? (aiball check)`);
    process.exit(1);
}

interface Stat { label: string; median: number; min: number; p90: number; bytes: number }

function summarise(label: string, samples: number[], bytes: number): Stat {
    const s = [...samples].sort((a, b) => a - b);
    return {
        label,
        median: s[Math.floor(s.length / 2)],
        min: s[0],
        p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))],
        bytes,
    };
}

function table(title: string, rows: Stat[]): void {
    console.log(`\n${title}`);
    const w = Math.max(...rows.map((r) => r.label.length));
    console.log(`  ${"".padEnd(w)}   median      min      p90     size`);
    for (const r of rows) {
        console.log(
            `  ${r.label.padEnd(w)}  ${r.median.toFixed(1).padStart(6)} ms`
            + ` ${r.min.toFixed(1).padStart(7)} ${r.p90.toFixed(1).padStart(8)}`
            + `  ${fmtBytes(r.bytes).padStart(7)}`,
        );
    }
}

const fmtBytes = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(0)} kB` : `${n} B`);

// ---------------------------------------------------------------------------
//  API over the Unix socket
// ---------------------------------------------------------------------------

function apiGet(path: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = request(
            { socketPath: SOCK, path, method: "GET", headers: { "x-aiball-consumer": CONSUMER } },
            (res) => {
                let size = 0;
                res.on("data", (c: Buffer) => { size += c.length; });
                res.on("end", () => {
                    // A 404 answers fast and would look like a great score;
                    // an earlier bench on this board recorded exactly that.
                    if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode} on ${path}`));
                    else resolve(size);
                });
            },
        );
        req.on("error", reject);
        req.end();
    });
}

async function benchApi(label: string, path: string): Promise<Stat> {
    for (let i = 0; i < WARMUP; i++) await apiGet(path);
    const samples: number[] = [];
    let bytes = 0;
    for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        bytes = await apiGet(path);
        samples.push(performance.now() - t0);
    }
    return summarise(label, samples, bytes);
}

// ---------------------------------------------------------------------------
//  MCP over stdio
// ---------------------------------------------------------------------------

class McpClient {
    private child: ChildProcessWithoutNullStreams;
    private buf = "";
    private pending = new Map<number, (v: { size: number }) => void>();
    private nextId = 1;

    constructor() {
        this.child = spawn("node", ["bin/aiball-mcp"], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, AIBALL_AGENT: CONSUMER, AIBALL_PROJECT: PROJECT },
        }) as ChildProcessWithoutNullStreams;
        this.child.stdout.on("data", (c: Buffer) => this.onData(c.toString("utf8")));
        this.child.stderr.resume();
    }

    private onData(chunk: string): void {
        this.buf += chunk;
        for (;;) {
            const nl = this.buf.indexOf("\n");
            if (nl < 0) return;
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: { id?: number };
            try { msg = JSON.parse(line) as { id?: number }; } catch { continue; }
            if (msg.id === undefined) continue;
            const resolve = this.pending.get(msg.id);
            if (resolve) {
                this.pending.delete(msg.id);
                resolve({ size: Buffer.byteLength(line, "utf8") });
            }
        }
    }

    send(method: string, params: unknown): Promise<{ size: number }> {
        const id = this.nextId++;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }

    call(name: string, args: Record<string, unknown>): Promise<{ size: number }> {
        return this.send("tools/call", { name, arguments: args });
    }

    close(): void { this.child.kill(); }
}

async function benchMcp(client: McpClient, label: string, tool: string, args: Record<string, unknown>): Promise<Stat> {
    for (let i = 0; i < WARMUP; i++) await client.call(tool, args);
    const samples: number[] = [];
    let bytes = 0;
    for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        bytes = (await client.call(tool, args)).size;
        samples.push(performance.now() - t0);
    }
    return summarise(label, samples, bytes);
}

// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

async function main(): Promise<void> {
    console.log(`aiball bench — socket ${SOCK}`);
    console.log(`consumer ${CONSUMER}, project ${PROJECT}, ${RUNS} runs after ${WARMUP} warmup, sequential`);

    const api: Stat[] = [];
    api.push(await benchApi("health", "/api/health"));
    api.push(await benchApi("micro-status", `/api/micro-status?consumer_id=${enc(CONSUMER)}&project=${enc(PROJECT)}`));
    api.push(await benchApi("tickets actionable/10", `/api/tickets?project=${enc(PROJECT)}&actionable=1&limit=10`));
    api.push(await benchApi("tickets open/30", `/api/tickets?project=${enc(PROJECT)}&open=1&limit=30`));
    api.push(await benchApi("tickets open/30 x-proj", "/api/tickets?open=1&limit=30"));
    api.push(await benchApi("tickets open, no limit", `/api/tickets?project=${enc(PROJECT)}&open=1`));
    api.push(await benchApi("inbox", `/api/inbox?project=${enc(PROJECT)}`));
    api.push(await benchApi("projects detailed", "/api/projects?detailed=1"));
    table("API over the Unix socket", api);

    if (API_ONLY) return;

    const mcp = new McpClient();
    try {
        await mcp.send("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "aiball-bench", version: "0" },
        });
        const rows: Stat[] = [];
        rows.push(await benchMcp(mcp, "poll", "poll", {}));
        rows.push(await benchMcp(mcp, "unread (pings)", "unread", { pings: true }));
        rows.push(await benchMcp(mcp, "ticket_list actionable/10", "ticket_list", { project: PROJECT, actionable: true, limit: 10 }));
        rows.push(await benchMcp(mcp, "ticket_list open/30", "ticket_list", { project: PROJECT, open: true, limit: 30 }));
        rows.push(await benchMcp(mcp, "ticket_list open/30 x-proj", "ticket_list", { open: true, limit: 30 }));
        rows.push(await benchMcp(mcp, "ticket_get header", "ticket_get", { ticket_id: 2165 }));
        rows.push(await benchMcp(mcp, "ticket_get brief", "ticket_get", { ticket_id: 2165, brief: true }));
        table("MCP over stdio (= the API call + _status + JSON-RPC + serialisation)", rows);
    } finally {
        mcp.close();
    }
}

await main();
