/**
 * #3066 — the session hosts this daemon runs (docs/SESSION-HOST.md). Each is
 * a `cl-session-host` process started detached, so it outlives the daemon's
 * restarts; the daemon finds them again from `$AIBALL_HOME/hosts/<dir>/host.json`
 * and takes their control channel back. Claude's bytes never pass through here:
 * clients attach to the host's own socket.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIBALL_HOME } from "../paths.js";

/** A Unix socket's path is at most about 100 bytes. */
export const MAX_SOCKET_PATH = 100;

export const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function hostsDir(): string {
    return join(AIBALL_HOME, "hosts");
}

/** An agent's session lives in `hosts/<agent>`, a named one in `hosts/term-<name>`. */
export function hostDirFor(key: { agent?: string; name?: string }): string {
    return join(hostsDir(), key.agent ? key.agent : `term-${key.name}`);
}

/** The binary: `CL_SESSION_HOST_BIN`, or this checkout's release build. */
export function sessionHostBin(): string {
    const override = process.env.CL_SESSION_HOST_BIN?.trim();
    if (override) return override;
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..", "windows", "cl-pty-proxy", "target", "release", "cl-session-host");
}

export interface HostInfo {
    agent: string | null;
    name: string | null;
    pid: number;
    cwd: string;
    dir: string;
}

/**
 * A live host: its control channel (JSON-RPC 2.0, one message per line), its
 * notifications as events (`host.screen_changed`, `host.keys`, `host.clients`,
 * `host.exited`), and what it reported last.
 */
export class HostLink extends EventEmitter {
    private next = 1;
    private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private buf = "";
    clients = 0;
    running = false;

    private constructor(readonly info: HostInfo, private readonly sock: Socket) {
        super();
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string) => this.receive(chunk));
        sock.on("close", () => {
            for (const p of this.pending.values()) p.reject(new Error("host control channel closed"));
            this.pending.clear();
            this.emit("gone");
        });
        sock.on("error", () => { /* surfaced by close */ });
        this.on("host.clients", (p: { count: number }) => { this.clients = p.count; });
        this.on("host.exited", () => { this.running = false; });
    }

    static open(info: HostInfo, timeoutMs = 3000): Promise<HostLink> {
        return new Promise((resolveOpen, reject) => {
            const sock = connect(join(info.dir, "control.sock"));
            const timer = setTimeout(() => { sock.destroy(); reject(new Error("host did not answer")); }, timeoutMs);
            sock.once("connect", async () => {
                clearTimeout(timer);
                const link = new HostLink(info, sock);
                try {
                    const hello = await link.call<{ claude: { running: boolean }; clients: number }>("host.hello");
                    link.running = hello.claude.running;
                    link.clients = hello.clients;
                    resolveOpen(link);
                } catch (e) {
                    sock.destroy();
                    reject(e as Error);
                }
            });
            sock.once("error", (e) => { clearTimeout(timer); reject(e); });
        });
    }

    private receive(chunk: string): void {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            if (!line.trim()) continue;
            let m: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
            try { m = JSON.parse(line); } catch { continue; }
            if (typeof m.id === "number") {
                const p = this.pending.get(m.id);
                if (!p) continue;
                this.pending.delete(m.id);
                if (m.error) p.reject(Object.assign(new Error(m.error.message), { rpcCode: m.error.code }));
                else p.resolve(m.result);
            } else if (m.method) {
                this.emit(m.method, m.params);
            }
        }
    }

    call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
        const id = this.next++;
        return new Promise<T>((resolveCall, reject) => {
            this.pending.set(id, { resolve: resolveCall as (v: unknown) => void, reject });
            this.sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }

    close(): void {
        this.sock.destroy();
    }

    attachSocket(): string {
        return join(this.info.dir, "attach.sock");
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readInfo(dir: string): HostInfo | null {
    try {
        const j = JSON.parse(readFileSync(join(dir, "host.json"), "utf8")) as { agent?: string | null; name?: string | null; pid?: number; cwd?: string };
        if (typeof j.pid !== "number") return null;
        return { agent: j.agent ?? null, name: j.name ?? null, pid: j.pid, cwd: j.cwd ?? "", dir };
    } catch {
        return null;
    }
}

/** Every host directory: a live host is opened, a dead one's directory removed. */
export async function discoverHosts(): Promise<HostLink[]> {
    const root = hostsDir();
    if (!existsSync(root)) return [];
    const links: HostLink[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        const info = readInfo(dir);
        if (!info || !alive(info.pid)) {
            rmSync(dir, { recursive: true, force: true });
            continue;
        }
        try {
            links.push(await HostLink.open(info));
        } catch {
            // Alive but not answering: left alone, the next start will tell.
        }
    }
    return links;
}

export interface StartHost {
    agent?: string;
    name?: string;
    argv: string[];
    cwd: string;
    size?: { rows: number; cols: number };
    env: Record<string, string>;
}

/** Start a host, detached; resolves once it answers on its control channel. */
export async function startHost(o: StartHost): Promise<HostLink> {
    const dir = hostDirFor(o);
    if (join(dir, "control.sock").length > MAX_SOCKET_PATH) {
        throw new Error(`the host's socket path would be longer than ${MAX_SOCKET_PATH} bytes: ${dir}`);
    }
    const bin = sessionHostBin();
    if (!existsSync(bin)) throw new Error(`no session host at ${bin}: build it with cargo build --release --manifest-path windows/cl-pty-proxy/Cargo.toml`);
    if (!existsSync(o.cwd)) throw new Error(`no such directory: ${o.cwd}`);
    mkdirSync(hostsDir(), { recursive: true, mode: 0o700 });
    rmSync(dir, { recursive: true, force: true });
    const args = ["--dir", dir, ...(o.agent ? ["--agent", o.agent] : ["--name", o.name!])];
    if (o.size) args.push("--rows", String(o.size.rows), "--cols", String(o.size.cols));
    args.push("--", ...o.argv);
    // A spawn that fails (a missing cwd reads as ENOENT) is an 'error' event:
    // unheard, it kills the daemon.
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, detached: true, stdio: "ignore" });
    let spawnError: Error | null = null;
    child.on("error", (e) => { spawnError = e; });
    child.unref();
    const deadline = Date.now() + 5000;
    while (!existsSync(join(dir, "host.json"))) {
        if (spawnError) throw new Error(`the session host could not start: ${(spawnError as Error).message}`);
        if (Date.now() > deadline) throw new Error("the session host did not come up");
        if (child.exitCode !== null) throw new Error(`the session host exited (${child.exitCode})`);
        await new Promise((r) => setTimeout(r, 25));
    }
    const info = readInfo(dir);
    if (!info) throw new Error("the session host wrote no host.json");
    return HostLink.open(info);
}
