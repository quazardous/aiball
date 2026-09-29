/**
 * Board simulator: the real daemon and web UI in a throwaway container, a cohort
 * of simulated agents driven through the real MCP tool handlers, and a human
 * moderator on the web UI.
 *
 *     npm run sim -- up [cohort.yaml]            start the container, provision the cohort
 *     npm run sim -- up --from-live --as a,b     start it on a sanitized copy of the live board, playing real agents
 *     npm run sim -- wake <agent>                what the loop does when the agent goes idle, now
 *     npm run sim -- mcp <agent> <tool> [json]   call an MCP tool as that agent
 *     npm run sim -- view [agent...]             each agent's seat: backlog, gates, next wake
 *     npm run sim -- run [--keep] [--critical] [--shards N] [scenario...]
 *                                                play scenarios (default: tests/sim/scenarios/*.yaml),
 *                                                each on a board reset to empty with its own cohort
 *                                                unless --keep; --critical plays only the scenarios
 *                                                marked `critical: true`; --shards N splits them over
 *                                                N boards played side by side
 *     npm run sim -- pending                     what waits for the moderator
 *     npm run sim -- approve|reject <id>         moderate a pending ticket or comment
 *     npm run sim -- down                        stop the container and drop its database
 *
 * The container is `tests/docker-compose.yml`'s daemon under its own compose
 * project (`aiball-sim`) and port (AIBALL_SIM_PORT, default 17780), so it never
 * meets the live board nor `npm run test:e2e`. A shard (AIBALL_SIM_SHARD=k, set
 * by `run --shards`) gets its own project, port (17780 + k) and state file.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { formatView, nextWake, type ViewRow } from "../../src/sim/view.js";
import { BusClient } from "../../src/bus-client.js";
import { sanitizeCopy } from "../../src/sim/sanitize.js";
import { DEFAULT_COOLDOWN_SEC, matchSeat, parseDuration, parseScenario, pick, scenarioCohort, scenarioIsCritical, substitute, type Seat, type Step, type UnreadEvent } from "../../src/sim/scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const BASE_PORT = 17780;
// #3016 — a shard plays beside the others: its own compose project, port and state.
const SHARD = process.env.AIBALL_SIM_SHARD ?? "";
const PORT = process.env.AIBALL_SIM_PORT ?? String(BASE_PORT + (SHARD ? Number(SHARD) : 0));
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_FILE = join(HERE, ".state", SHARD ? `cohort-${SHARD}.json` : "cohort.json");
const SCENARIOS = join(HERE, "scenarios");
/** #3380 — the images were built once for the whole run: no board rebuilds them. */
const PREBUILT = !!process.env.AIBALL_TEST_PREBUILT;
const COMPOSE = ["compose", "-p", SHARD ? `aiball-sim-${SHARD}` : "aiball-sim", "-f", join(ROOT, "tests/docker-compose.yml"), "-f", join(ROOT, "tests/docker-compose.sim.yml")];
/** #3016 — the shared node_modules volume: named after what fills it, so it is never stale. */
const NM_VOLUME = `aiball-sim-nm-${createHash("sha256")
    .update(readFileSync(join(ROOT, "package-lock.json")))
    .update(readFileSync(join(ROOT, "tests/Dockerfile")))
    .digest("hex").slice(0, 12)}`;

interface SimState {
    moderator: { id: string; password: string; token: string };
    projects: string[];
    agents: Record<string, { project: string; role: string; token: string }>;
}

function die(message: string, code = 1): never {
    console.error(message);
    process.exit(code);
}

function docker(args: string[], capture = false): string {
    const env = { ...process.env, AIBALL_TEST_PORT: PORT, AIBALL_SIM_NM: NM_VOLUME };
    if (capture) {
        return execFileSync("docker", [...COMPOSE, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    }
    const r = spawnSync("docker", [...COMPOSE, ...args], { env, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`docker compose ${args[0]} failed`);
    return "";
}

function loadState(): SimState {
    if (!existsSync(STATE_FILE)) throw new Error("the simulator is not up: run `npm run sim -- up` first");
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SimState;
}

/**
 * #3068 — a call to the core, on the bus. #3016 — one connection per call,
 * never a pooled one: with boards playing side by side, a reused connection
 * the daemon had just closed failed mid-scenario, the daemon up and well. A
 * call on a connection of its own cannot meet a closed one, and on loopback a
 * new connection costs nothing.
 */
async function call<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const bus = await BusClient.connect({ url: BASE, token });
    try {
        return await bus.call<T>(method, params);
    } catch (e) {
        throw new Error(`${method} ${JSON.stringify(params)}: ${(e as Error).message}`);
    } finally {
        bus.close();
    }
}

async function waitHealthy(): Promise<void> {
    for (let i = 0; i < 60; i++) {
        if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`the sim daemon did not answer on ${BASE}`);
}

/** Run provisioning in the container and keep the cohort it prints (tokens included). */
function provision(args: string[]): void {
    const out = docker(["exec", "-T", "daemon", "npx", "tsx", "tests/sim/provision.ts", ...args], true);
    const line = out.split("\n").find((l) => l.startsWith("SIM-COHORT:"));
    if (!line) throw new Error(`provisioning printed no cohort:\n${out}`);
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, line.slice("SIM-COHORT:".length), { mode: 0o600 });
    const state = loadState();
    console.log(`simulated board up: ${BASE}`);
    console.log(`  moderator (web UI login): ${state.moderator.id} / ${state.moderator.password}`);
    for (const [id, a] of Object.entries(state.agents)) console.log(`  agent ${id}: ${a.role} of ${a.project}`);
}

function cohortPath(cohortArg: string | undefined): string {
    const cohort = relative(ROOT, resolve(cohortArg ?? join(HERE, "cohort.yaml")));
    if (cohort.startsWith("..")) throw new Error("the cohort file must live inside the repository (the container mounts it)");
    return cohort;
}

/**
 * #3016 — create and fill the shared node_modules volume once, before any board
 * mounts it: a volume two boards filled at the same time would be torn. Filling
 * it is Docker's own copy of the image's node_modules into an empty volume, done
 * by a throwaway container. Volumes left by an older lockfile are removed.
 */
function ensureNodeModulesVolume(): void {
    const has = spawnSync("docker", ["volume", "inspect", NM_VOLUME], { stdio: "ignore" }).status === 0;
    if (has) return;
    if (!PREBUILT) docker(["build", "daemon"]);
    spawnSync("docker", ["volume", "create", NM_VOLUME], { stdio: "ignore" });
    docker(["run", "--rm", "--no-deps", "daemon", "true"]);
    const old = spawnSync("docker", ["volume", "ls", "-q", "--filter", "name=aiball-sim-nm-"], { encoding: "utf8" }).stdout
        .split("\n").map((v) => v.trim()).filter((v) => v && v !== NM_VOLUME);
    for (const v of old) spawnSync("docker", ["volume", "rm", v], { stdio: "ignore" });
}

async function up(cohortArg: string | undefined): Promise<void> {
    const cohort = cohortPath(cohortArg);
    ensureNodeModulesVolume();
    docker(["up", "-d", PREBUILT ? "--no-build" : "--build", "daemon"]);
    await waitHealthy();
    provision([cohort]);
}

function boardRunning(): boolean {
    try {
        return docker(["ps", "-q", "daemon"], true).trim() !== "";
    } catch {
        return false;
    }
}

/**
 * #3016 — empty the running board instead of rebuilding its container. A new
 * container costs ~55 s (created, its node_modules volume refilled, then
 * removed); emptying the data directory and restarting the daemon in place
 * costs ~4 s. The next boot finds no database and starts from zero, as a new
 * container would.
 */
async function reset(cohortArg: string | undefined): Promise<void> {
    const cohort = cohortPath(cohortArg);
    docker(["exec", "-T", "daemon", "sh", "-c", "rm -rf /data/* /data/.[!.]*"]);
    docker(["restart", "daemon"]);
    rmSync(STATE_FILE, { force: true });
    await waitHealthy();
    provision([cohort]);
}

/**
 * #2345 — the simulated board on a copy of the live one. The live database is
 * only read (SQLite's own backup, consistent under a daemon writing), the copy
 * is wiped of every credential on this host BEFORE it reaches the container,
 * and only the agents named by `--as` get a token. The live board is never
 * touched: the copy lives in the simulator's own volume, served on loopback.
 */
async function upFromLive(agents: string[]): Promise<void> {
    if (agents.length === 0) throw new Error("usage: sim up --from-live --as <agent>[,<agent>]");
    const liveHome = process.env.AIBALL_LIVE_HOME ?? join(homedir(), ".local/share/aiball");
    const liveDb = join(liveHome, "aiball.db");
    if (!existsSync(liveDb)) throw new Error(`no live database at ${liveDb} (set AIBALL_LIVE_HOME)`);
    const dir = mkdtempSync(join(tmpdir(), "aiball-sim-live-"));
    const copy = join(dir, "aiball.db");
    try {
        const live = new Database(liveDb, { readonly: true });
        await live.backup(copy);
        live.close();
        const db = new Database(copy);
        const wiped = sanitizeCopy(db);
        db.pragma("journal_mode = DELETE");
        db.close();
        console.log(`live copy wiped of its credentials: ${Object.entries(wiped).map(([t, n]) => `${t} ${n}`).join(", ")}`);
        // A fresh volume, then the copy in it before the daemon first opens it.
        if (existsSync(STATE_FILE)) down();
        else docker(["down", "-v"]);
        docker(["create", "--build", "daemon"]);
        docker(["cp", copy, "daemon:/data/aiball.db"]);
        docker(["up", "-d", "daemon"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    await waitHealthy();
    provision(["--from-live", "--as", agents.join(",")]);
}

function down(): void {
    docker(["down", "-v"]);
    rmSync(STATE_FILE, { force: true });
    console.log("simulated board removed");
}

/** Call a tool exactly as the agent's MCP server would: same handlers, same schema. */
async function mcp(agent: string | undefined, tool: string | undefined, json: string | undefined): Promise<void> {
    if (!agent || !tool) die("usage: sim mcp <agent> <tool> [json]", 2);
    const state = loadState();
    const seat = state.agents[agent] ?? die(`no agent ${agent} in the cohort (${Object.keys(state.agents).join(", ")})`);
    let args: Record<string, unknown>;
    try {
        args = json ? JSON.parse(json) as Record<string, unknown> : {};
    } catch (e) {
        die(`arguments are not JSON: ${(e as Error).message}`, 2);
    }

    // The MCP client reads its identity and daemon from the environment when it
    // is imported, so set it first. The session's own loop identity must not leak in.
    Object.assign(process.env, {
        AIBALL_URL: BASE, AIBALL_TOKEN: seat.token, AIBALL_AGENT: agent, AIBALL_PROJECT: seat.project, AIBALL_SOCK: "",
    });
    delete process.env.AIBALL_CWD;
    const { CL_ENV } = await import("../../src/claude-loop/env-vars.js");
    delete process.env[CL_ENV.STATE_DIR];

    type Handler = (a: Record<string, unknown>) => Promise<{ content?: { text?: string }[]; isError?: boolean }>;
    const tools = new Map<string, { schema: Record<string, unknown>; handler: Handler }>();
    const server = {
        registerTool: (name: string, config: { inputSchema?: Record<string, unknown> }, handler: Handler) => {
            tools.set(name, { schema: config.inputSchema ?? {}, handler });
        },
    } as never;
    const modules = await Promise.all([
        import("../../src/mcp/ticket-write.js").then((m) => m.registerTicketWriteTools),
        import("../../src/mcp/ticket-read.js").then((m) => m.registerTicketReadTools),
        import("../../src/mcp/ticket-relations.js").then((m) => m.registerTicketRelationTools),
        import("../../src/mcp/subscription.js").then((m) => m.registerSubscriptionTools),
        import("../../src/mcp/inbox.js").then((m) => m.registerInboxTools),
    ]);
    for (const register of modules) register(server);

    const entry = tools.get(tool) ?? die(`no MCP tool ${tool} (${[...tools.keys()].sort().join(", ")})`, 2);
    const { z } = await import("zod");
    const parsed = z.object(entry.schema as never).safeParse(args);
    if (!parsed.success) die(`invalid arguments for ${tool}:\n${parsed.error.message}`, 2);
    let result: Awaited<ReturnType<Handler>>;
    try {
        result = await entry.handler(parsed.data as Record<string, unknown>);
    } catch (e) {
        die(`${tool} failed: ${(e as Error).message}`);
    }
    for (const c of result.content ?? []) if (c.text) console.log(c.text);
    if (result.isError) process.exit(1);
}

/**
 * One agent's gesture in its own process: the MCP client is bound to one
 * identity when it is imported, so a scenario with several agents cannot share one.
 */
function mcpGesture(agent: string, tool: string, args: Record<string, unknown>): { ok: true; result: unknown } | { ok: false; error: string } {
    const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "mcp", agent, tool, JSON.stringify(args)], {
        encoding: "utf8",
        env: process.env,
    });
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
    const out = r.stdout.trim();
    try {
        return { ok: true, result: JSON.parse(out) };
    } catch {
        return { ok: true, result: out };
    }
}

/** What the agent sees: its project's open tickets, its unread pings, and the head its loop would pick. */
async function fetchSeat(state: SimState, agent: string, cooldownSec = DEFAULT_COOLDOWN_SEC): Promise<Seat> {
    const seat = state.agents[agent];
    if (!seat) throw new Error(`no agent ${agent} in the cohort`);
    // Scoped to the agent's project, as its MCP tools and its loop are: unscoped,
    // another project's ticket reads as actionable to an agent that never sees it.
    const rows = await call<ViewRow[]>(seat.token, "ticket.list", { project: seat.project, open: "1", limit: "500" });
    const pings = await call<{ unread: number }>(seat.token, "ping.count", { consumer_id: agent });
    // The loop's own pick (src/claude-loop/state.ts): its project's backlog, the
    // first row neither in cooldown nor actionable-but-not-claimable — a head the
    // agent could not claim never gets a "Triage" wake.
    const backlog = await call<(ViewRow & { backlog_cooled_until?: string | null })[]>(
        seat.token, "ticket.list", { project: seat.project, backlog: "1", limit: "500", cooldown_sec: String(cooldownSec) });
    const head = backlog.find((r) => !r.backlog_cooled_until && !(r.actionable === true && r.claimable === false)) ?? null;
    // The queue an event wake is picked from, oldest first.
    const queued = await call<{ messages?: UnreadEvent[] } | UnreadEvent[]>(seat.token, "unread.list", { consumer_id: agent, limit: 500 });
    const unread = (Array.isArray(queued) ? queued : queued.messages ?? [])
        .map((m) => ({ id: m.id, kind: m.kind, ticket_id: m.ticket_id ?? null }));
    return { rows, unreadPings: pings.unread, head, unread };
}

async function view(agents: string[]): Promise<void> {
    const state = loadState();
    for (const id of agents.length > 0 ? agents : Object.keys(state.agents)) {
        const seat = await fetchSeat(state, id);
        console.log(formatView(id, seat.rows, seat.unreadPings, seat.head));
        console.log("");
    }
}

async function pending(): Promise<void> {
    const state = loadState();
    const rows = await call<{ id: number; kind: string; ticket_id: number | null; by_agent: string; title: string | null }[]>(
        state.moderator.token, "message.list", { status: "pending", summary: true });
    if (rows.length === 0) return void console.log("nothing waits for the moderator");
    for (const m of rows) {
        const what = m.kind === "ticket_created" ? `ticket "${m.title}"` : `${m.kind} on #${m.ticket_id}`;
        console.log(`  ${m.id}  ${what} by ${m.by_agent}`);
    }
}

/** The moderator's gestures, through the same methods as the web UI. */
async function moderatorGesture(state: SimState, action: string, target: unknown, arg: string | null, body: string | null): Promise<string> {
    const id = Number(target);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`moderator: ${action} needs a numeric id, got ${String(target)}`);
    const token = state.moderator.token;
    switch (action) {
        case "approve":
        case "reject": {
            const m = await call<{ status: string }>(token, `message.${action}`, { id });
            return `${id} is ${m.status}`;
        }
        case "accept":
        case "refuse": {
            await call(token, "message.decide", { id, status: action === "accept" ? "accepted" : "rejected" });
            return `decision on ${id} ${action === "accept" ? "accepted" : "rejected"}`;
        }
        case "comment": {
            const ticket = await call<{ project: string }>(token, "message.get", { id });
            const m = await call<{ id: number }>(token, "message.post", {
                // The author is the moderator the token names (a human: no summary_until needed).
                project: ticket.project, kind: "comment_added", ticket_id: id, body,
            });
            return `comment ${m.id} on #${id}`;
        }
        case "close":
        case "reopen": {
            const ticket = await call<{ project: string }>(token, "message.get", { id });
            await call(token, "message.post", {
                project: ticket.project, kind: action === "close" ? "ticket_closed" : "ticket_reopened", ticket_id: id,
            });
            return `#${id} ${action === "close" ? "closed" : "reopened"}`;
        }
        case "snooze": {
            const seconds = parseDuration(arg ?? "");
            if (seconds === null) throw new Error(`moderator: snooze needs a duration, got ${String(arg)}`);
            const until = new Date(Date.now() + seconds * 1000).toISOString();
            await call(token, "ticket.postpone", { id, until });
            return `#${id} snoozed until ${until}`;
        }
        case "step": {
            await call(token, "message.step", { id });
            return `comment ${id} tagged as a step`;
        }
        case "assign": {
            await call(token, "ticket.assign", { id, assignee: arg });
            return `#${id} assigned to ${String(arg)}`;
        }
        default:
            throw new Error(`unknown moderator action ${action}`);
    }
}

/**
 * What the loop does when the agent goes idle: unread pings make an event wake
 * (the oldest event with the others on its ticket, marked seen); otherwise it
 * names its backlog head and records the wake, which starts that ticket's cooldown.
 */
async function wakeAgent(state: SimState, agent: string, cooldownSec = DEFAULT_COOLDOWN_SEC): Promise<string> {
    const seat = await fetchSeat(state, agent, cooldownSec);
    const token = state.agents[agent]!.token;
    if (seat.unreadPings > 0 && seat.unread.length > 0) {
        const key = seat.unread[0]!.ticket_id ?? seat.unread[0]!.id;
        const delivered = seat.unread.filter((e) => (e.ticket_id ?? e.id) === key);
        for (const e of delivered) await call(token, "unread.mark_read", { consumer_id: agent, message_id: e.id });
        return ` by events on #${key}: ${delivered.map((e) => e.kind).join(", ")}`;
    }
    if (seat.head) await call(token, "backlog.record_wake", { consumer_id: agent, ticket_id: seat.head.id });
    return `: ${nextWake(0, seat.head)}`;
}

function describe(step: Step): string {
    switch (step.kind) {
        case "mcp": return `${step.agent} → ${step.tool} ${JSON.stringify(step.args)}${step.refused ? ` (must be refused: ${step.refused})` : ""}`;
        case "moderator": return `moderator → ${step.action} ${String(step.target)}${step.arg ? ` ${step.arg}` : ""}`;
        case "sleep": return `sleep ${step.seconds}s`;
        case "view": return `view ${step.agents.join(", ")}`;
        case "expect": return `expect ${Object.keys(step.seats).join(", ")}`;
        case "wake": return `wake ${step.agent}`;
        case "pause": return `pause: ${step.message}`;
    }
}

/** Play one scenario on the current board. Returns how many checks failed. */
async function play(file: string): Promise<number> {
    const state = loadState();
    let scenario: ReturnType<typeof parseScenario>;
    try {
        scenario = parseScenario(readFileSync(file, "utf8"), Object.keys(state.agents));
    } catch (e) {
        // One unreadable file must not hide how the others play.
        console.log(`\n▶ ${relative(ROOT, file)}\n  ✗ ${(e as Error).message}`);
        return 1;
    }
    console.log(`\n▶ ${scenario.name}  (${relative(ROOT, file)})`);
    const startedAt = Date.now();
    const vars: Record<string, unknown> = {};
    let failed = 0;
    for (const [i, step] of scenario.steps.entries()) {
        const n = `  ${String(i + 1).padStart(2)}.`;
        try {
            if (step.kind === "mcp") {
                const args = substitute(step.args, vars);
                const r = mcpGesture(step.agent, step.tool, args);
                if (step.refused !== null) {
                    if (r.ok) throw new Error(`${describe(step)}: accepted, but it had to be refused`);
                    if (!r.error.includes(step.refused)) throw new Error(`${describe(step)}: refused, but not with "${step.refused}":\n${r.error}`);
                    console.log(`${n} ✓ ${step.agent} → ${step.tool}: refused (${step.refused})`);
                    continue;
                }
                if (!r.ok) throw new Error(`${describe(step)}: ${r.error}`);
                for (const [name, path] of Object.entries(step.save)) {
                    const value = pick(r.result, path);
                    if (value === undefined) throw new Error(`${describe(step)}: the result has no ${path} to save as $${name}`);
                    vars[name] = value;
                }
                const saved = Object.keys(step.save).map((k) => `$${k}=${String(vars[k])}`).join(" ");
                console.log(`${n} ✓ ${step.agent} → ${step.tool}${saved ? `  ${saved}` : ""}`);
            } else if (step.kind === "moderator") {
                try {
                    console.log(`${n} ✓ moderator: ${await moderatorGesture(state, step.action, substitute(step.target, vars), step.arg, step.body)}`);
                } catch (e) {
                    if (!step.mayFail) throw e;
                    // A pin-down asks what the board does: a refusal is an answer too.
                    console.log(`${n} ◦ moderator: ${step.action} ${String(substitute(step.target, vars))} refused — ${(e as Error).message}`);
                }
            } else if (step.kind === "view") {
                console.log(`${n} view`);
                for (const agent of step.agents) {
                    const seat = await fetchSeat(state, agent, scenario.cooldownSec);
                    console.log(formatView(agent, seat.rows, seat.unreadPings, seat.head).replace(/^/gm, "      "));
                }
            } else if (step.kind === "expect") {
                for (const [agent, expectation] of Object.entries(step.seats)) {
                    const e = substitute(expectation, vars);
                    const misses = matchSeat(e, await fetchSeat(state, agent, scenario.cooldownSec));
                    if (misses.length === 0) {
                        console.log(`${n} ✓ ${agent} on #${String(e.ticket)}`);
                    } else {
                        failed++;
                        console.log(`${n} ✗ ${agent} on #${String(e.ticket)}: ${misses.join("; ")}`);
                    }
                }
            } else if (step.kind === "wake") {
                console.log(`${n} ✓ ${step.agent} woken${await wakeAgent(state, step.agent, scenario.cooldownSec)}`);
            } else if (step.kind === "sleep") {
                console.log(`${n} … sleeping ${step.seconds}s`);
                await new Promise((r) => setTimeout(r, step.seconds * 1000));
            } else {
                if (process.stdin.isTTY) {
                    const rl = createInterface({ input: process.stdin, output: process.stdout });
                    await rl.question(`${n} ⏸ ${step.message} — press Enter to go on `);
                    rl.close();
                } else {
                    console.log(`${n} ⏸ ${step.message} (not a terminal: going on)`);
                }
            }
        } catch (e) {
            // A gesture that fails leaves the later steps nothing sound to stand on.
            console.log(`${n} ✗ ${(e as Error).message}`);
            // #3016 — a lost connection says nothing by itself: show what the daemon last said.
            if (/fetch failed|ECONNRE|ECONNREFUSED|EPIPE|socket hang up|network error/.test((e as Error).message)) {
                try {
                    const logs = docker(["logs", "--tail", "40", "daemon"], true);
                    console.log(logs.replace(/^/gm, "      | "));
                } catch { /* the container may be gone */ }
            }
            console.log("      scenario stopped");
            return failed + 1;
        }
    }
    // #3016 — each scenario's time, so the shards are balanced on measure, not guess.
    const took = `${Math.round((Date.now() - startedAt) / 1000)} s`;
    console.log(failed === 0 ? `  passed in ${took}` : `  ${failed} check(s) failed, in ${took}`);
    return failed;
}

/** Rough seconds a scenario takes: its sleeps, plus a flat share for the board reset and the gestures. */
function scenarioWeightSec(text: string): number {
    let sleeps = 0;
    for (const m of text.matchAll(/^\s*-\s*sleep:\s*(\S+)/gm)) sleeps += parseDuration(m[1]!) ?? 0;
    return sleeps + 15;
}

/**
 * #3016 — play the scenarios over `n` boards side by side, each a child `run`
 * with its own shard number (project, port, state). Their output is prefixed
 * with the shard; the verdict fails when any shard does. Each shard's board is
 * removed afterwards unless --keep.
 */
async function runShards(files: string[], n: number, keep: boolean): Promise<void> {
    // Longest first, each onto the lightest board: the scenarios' own sleeps
    // (cooldowns, snoozes running out) are most of the time, and dealt round-robin
    // they can pile up on one board.
    const buckets: string[][] = Array.from({ length: n }, () => []);
    const load = new Array<number>(n).fill(0);
    const weighed = files.map((f) => ({ f, w: scenarioWeightSec(readFileSync(f, "utf8")) })).sort((a, b) => b.w - a.w);
    for (const { f, w } of weighed) {
        const k = load.indexOf(Math.min(...load));
        buckets[k]!.push(f);
        load[k]! += w;
    }
    const self = fileURLToPath(import.meta.url);
    const codes = await Promise.all(buckets.map((bucket, k) => new Promise<number>((done) => {
        const env: NodeJS.ProcessEnv = { ...process.env, AIBALL_SIM_SHARD: String(k + 1) };
        delete env.AIBALL_SIM_PORT;
        const child = spawn(process.execPath, [...process.execArgv, self, "run", ...(keep ? ["--keep"] : []), ...bucket], { env, stdio: ["ignore", "pipe", "pipe"] });
        const prefix = (chunk: Buffer) => chunk.toString().replace(/^(?=.)/gm, `[${k + 1}] `);
        child.stdout.on("data", (c: Buffer) => process.stdout.write(prefix(c)));
        child.stderr.on("data", (c: Buffer) => process.stderr.write(prefix(c)));
        child.on("close", (code) => done(code ?? 1));
    })));
    if (!keep) {
        for (let k = 1; k <= n; k++) {
            const env: NodeJS.ProcessEnv = { ...process.env, AIBALL_SIM_SHARD: String(k) };
            delete env.AIBALL_SIM_PORT;
            spawnSync(process.execPath, [...process.execArgv, self, "down"], { env, stdio: "ignore" });
        }
    }
    const failedShards = codes.filter((c) => c !== 0).length;
    console.log(`\n${files.length} scenario(s) over ${n} boards, ${failedShards === 0 ? "all passed" : `${failedShards} shard(s) failed`}`);
    if (failedShards > 0) process.exit(1);
}

async function run(args: string[]): Promise<void> {
    const keep = args.includes("--keep");
    const critical = args.includes("--critical");
    const shardsAt = args.indexOf("--shards");
    const shards = shardsAt >= 0 ? Number(args[shardsAt + 1]) : 1;
    if (!Number.isInteger(shards) || shards < 1) throw new Error("--shards takes a whole number of boards");
    const named = args.filter((a, i) => !a.startsWith("--") && !(shardsAt >= 0 && i === shardsAt + 1));
    let files = named.length > 0
        ? named.map((f) => resolve(f))
        : readdirSync(SCENARIOS).filter((f) => f.endsWith(".yaml")).sort().map((f) => join(SCENARIOS, f));
    if (critical) files = files.filter((f) => scenarioIsCritical(readFileSync(f, "utf8")));
    if (files.length === 0) throw new Error("no scenario to play");
    if (shards > 1 && !SHARD) {
        // Once, before the boards start side by side (see ensureNodeModulesVolume).
        ensureNodeModulesVolume();
        return runShards(files, Math.min(shards, files.length), keep);
    }
    let failed = 0;
    for (const file of files) {
        if (!keep) {
            // Every scenario starts from an empty board, so none reads another's leftovers.
            const cohort = scenarioCohort(readFileSync(file, "utf8")) ?? undefined;
            if (boardRunning()) await reset(cohort);
            else {
                if (existsSync(STATE_FILE)) down();
                await up(cohort);
            }
        }
        failed += await play(file);
    }
    console.log(`\n${files.length} scenario(s), ${failed === 0 ? "all passed" : `${failed} failure(s)`} — the last board stays up on ${BASE}`);
    if (failed > 0) process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
try {
    switch (command) {
        case "up": {
            const asIndex = rest.indexOf("--as");
            if (rest.includes("--from-live")) await upFromLive(asIndex >= 0 ? (rest[asIndex + 1] ?? "").split(",").map((a) => a.trim()).filter(Boolean) : []);
            else await up(rest[0]);
            break;
        }
        case "wake": {
            if (!rest[0]) die("usage: sim wake <agent>", 2);
            console.log(`${rest[0]} woken${await wakeAgent(loadState(), rest[0])}`);
            break;
        }
        case "down": down(); break;
        case "mcp": await mcp(rest[0], rest[1], rest[2]); break;
        case "view": await view(rest); break;
        case "run": await run(rest); break;
        case "pending": await pending(); break;
        case "approve":
        case "reject": {
            if (!rest[0]) die(`usage: sim ${command} <id>`, 2);
            console.log(await moderatorGesture(loadState(), command, rest[0], null, null));
            break;
        }
        default:
            die("usage: sim up [cohort.yaml] | up --from-live --as <agent>[,<agent>] | wake <agent> | mcp <agent> <tool> [json] | view [agent...] | run [--keep] [--critical] [--shards N] [scenario...] | pending | approve <id> | reject <id> | down", 2);
    }
} catch (e) {
    die((e as Error).message);
}
