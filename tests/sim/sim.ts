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
 *     npm run sim -- run [--keep] [scenario...]  play scenarios (default: tests/sim/scenarios/*.yaml),
 *                                                each on a fresh board with its own cohort unless --keep
 *     npm run sim -- pending                     what waits for the moderator
 *     npm run sim -- approve|reject <id>         moderate a pending ticket or comment
 *     npm run sim -- down                        stop the container and drop its database
 *
 * The container is `tests/docker-compose.yml`'s daemon under its own compose
 * project (`aiball-sim`) and port (AIBALL_SIM_PORT, default 17780), so it never
 * meets the live board nor `npm run test:e2e`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { formatView, nextWake, type ViewRow } from "../../src/sim/view.js";
import { sanitizeCopy } from "../../src/sim/sanitize.js";
import { DEFAULT_COOLDOWN_SEC, matchSeat, parseDuration, parseScenario, pick, scenarioCohort, substitute, type Seat, type Step, type UnreadEvent } from "../../src/sim/scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PORT = process.env.AIBALL_SIM_PORT ?? "17780";
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_FILE = join(HERE, ".state", "cohort.json");
const SCENARIOS = join(HERE, "scenarios");
const COMPOSE = ["compose", "-p", "aiball-sim", "-f", join(ROOT, "tests/docker-compose.yml")];

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
    const env = { ...process.env, AIBALL_TEST_PORT: PORT };
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

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
    return JSON.parse(text) as T;
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

async function up(cohortArg: string | undefined): Promise<void> {
    const cohort = relative(ROOT, resolve(cohortArg ?? join(HERE, "cohort.yaml")));
    if (cohort.startsWith("..")) throw new Error("the cohort file must live inside the repository (the container mounts it)");
    docker(["up", "-d", "--build", "daemon"]);
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
    const project = encodeURIComponent(seat.project);
    // Scoped to the agent's project, as its MCP tools and its loop are: unscoped,
    // another project's ticket reads as actionable to an agent that never sees it.
    const rows = await api<ViewRow[]>(seat.token, "GET", `/api/tickets?project=${project}&open=1&limit=500`);
    const pings = await api<{ unread: number }>(seat.token, "GET", `/api/pings/count?consumer_id=${encodeURIComponent(agent)}`);
    // The loop's own pick (src/claude-loop/state.ts): its project's backlog, the
    // first row neither in cooldown nor actionable-but-not-claimable — a head the
    // agent could not claim never gets a "Triage" wake.
    const backlog = await api<(ViewRow & { backlog_cooled_until?: string | null })[]>(
        seat.token, "GET", `/api/tickets?project=${project}&backlog=1&limit=500&cooldown_sec=${cooldownSec}`);
    const head = backlog.find((r) => !r.backlog_cooled_until && !(r.actionable === true && r.claimable === false)) ?? null;
    // The queue an event wake is picked from, oldest first.
    const queued = await api<{ messages?: UnreadEvent[] } | UnreadEvent[]>(seat.token, "GET", `/api/unread?consumer_id=${encodeURIComponent(agent)}&limit=500`);
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
    const rows = await api<{ id: number; kind: string; ticket_id: number | null; by_agent: string; title: string | null }[]>(
        state.moderator.token, "GET", "/api/messages?status=pending&summary=1");
    if (rows.length === 0) return void console.log("nothing waits for the moderator");
    for (const m of rows) {
        const what = m.kind === "ticket_created" ? `ticket "${m.title}"` : `${m.kind} on #${m.ticket_id}`;
        console.log(`  ${m.id}  ${what} by ${m.by_agent}`);
    }
}

/** The moderator's gestures, through the same routes as the web UI. */
async function moderatorGesture(state: SimState, action: string, target: unknown, arg: string | null, body: string | null): Promise<string> {
    const id = Number(target);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`moderator: ${action} needs a numeric id, got ${String(target)}`);
    const token = state.moderator.token;
    switch (action) {
        case "approve":
        case "reject": {
            const m = await api<{ status: string }>(token, "POST", `/api/messages/${id}/${action}`);
            return `${id} is ${m.status}`;
        }
        case "accept":
        case "refuse": {
            await api(token, "POST", `/api/messages/${id}/decide`, { status: action === "accept" ? "accepted" : "rejected" });
            return `decision on ${id} ${action === "accept" ? "accepted" : "rejected"}`;
        }
        case "comment": {
            const ticket = await api<{ project: string }>(token, "GET", `/api/messages/${id}`);
            const m = await api<{ id: number }>(token, "POST", "/api/messages", {
                // `by_agent` is what the route reads to exempt a human from summary_until.
                project: ticket.project, kind: "comment_added", ticket_id: id, body, by_agent: state.moderator.id,
            });
            return `comment ${m.id} on #${id}`;
        }
        case "close":
        case "reopen": {
            const ticket = await api<{ project: string }>(token, "GET", `/api/messages/${id}`);
            await api(token, "POST", "/api/messages", {
                project: ticket.project, kind: action === "close" ? "ticket_closed" : "ticket_reopened", ticket_id: id, by_agent: state.moderator.id,
            });
            return `#${id} ${action === "close" ? "closed" : "reopened"}`;
        }
        case "snooze": {
            const seconds = parseDuration(arg ?? "");
            if (seconds === null) throw new Error(`moderator: snooze needs a duration, got ${String(arg)}`);
            const until = new Date(Date.now() + seconds * 1000).toISOString();
            await api(token, "POST", `/api/tickets/${id}/postpone`, { until });
            return `#${id} snoozed until ${until}`;
        }
        case "assign": {
            await api(token, "POST", `/api/tickets/${id}/assign`, { assignee: arg });
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
        for (const e of delivered) await api(token, "POST", "/api/mark-read", { consumer_id: agent, message_id: e.id });
        return ` by events on #${key}: ${delivered.map((e) => e.kind).join(", ")}`;
    }
    if (seat.head) await api(token, "POST", "/api/backlog-wake", { consumer_id: agent, ticket_id: seat.head.id });
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
            console.log("      scenario stopped");
            return failed + 1;
        }
    }
    console.log(failed === 0 ? "  passed" : `  ${failed} check(s) failed`);
    return failed;
}

async function run(args: string[]): Promise<void> {
    const keep = args.includes("--keep");
    const named = args.filter((a) => a !== "--keep");
    const files = named.length > 0
        ? named.map((f) => resolve(f))
        : readdirSync(SCENARIOS).filter((f) => f.endsWith(".yaml")).sort().map((f) => join(SCENARIOS, f));
    if (files.length === 0) throw new Error("no scenario to play");
    let failed = 0;
    for (const file of files) {
        if (!keep) {
            // Every scenario starts from an empty board, so none reads another's leftovers.
            if (existsSync(STATE_FILE)) down();
            await up(scenarioCohort(readFileSync(file, "utf8")) ?? undefined);
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
            die("usage: sim up [cohort.yaml] | up --from-live --as <agent>[,<agent>] | wake <agent> | mcp <agent> <tool> [json] | view [agent...] | run [--keep] [scenario...] | pending | approve <id> | reject <id> | down", 2);
    }
} catch (e) {
    die((e as Error).message);
}
