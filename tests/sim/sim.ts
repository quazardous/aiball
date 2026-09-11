/**
 * Board simulator: the real daemon and web UI in a throwaway container, a cohort
 * of simulated agents driven through the real MCP tool handlers, and a human
 * moderator on the web UI.
 *
 *     npm run sim -- up [cohort.yaml]            start the container, provision the cohort
 *     npm run sim -- mcp <agent> <tool> [json]   call an MCP tool as that agent
 *     npm run sim -- view [agent...]             each agent's seat: backlog, gates, next wake
 *     npm run sim -- pending                     what waits for the moderator
 *     npm run sim -- approve|reject <id>         moderate a pending ticket or comment
 *     npm run sim -- down                        stop the container and drop its database
 *
 * The container is `tests/docker-compose.yml`'s daemon under its own compose
 * project (`aiball-sim`) and port (AIBALL_SIM_PORT, default 17780), so it never
 * meets the live board nor `npm run test:e2e`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatView, type ViewRow } from "../../src/sim/view.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PORT = process.env.AIBALL_SIM_PORT ?? "17780";
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_FILE = join(HERE, ".state", "cohort.json");
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
    if (r.status !== 0) die(`docker compose ${args[0]} failed`);
    return "";
}

function loadState(): SimState {
    if (!existsSync(STATE_FILE)) die("the simulator is not up: run `npm run sim -- up` first");
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SimState;
}

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) die(`${method} ${path} → ${r.status}: ${text}`);
    return JSON.parse(text) as T;
}

async function up(cohortArg: string | undefined): Promise<void> {
    const cohort = relative(ROOT, resolve(cohortArg ?? join(HERE, "cohort.yaml")));
    if (cohort.startsWith("..")) die("the cohort file must live inside the repository (the container mounts it)");
    docker(["up", "-d", "--build", "daemon"]);
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
        healthy = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
        if (!healthy) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) die(`the sim daemon did not answer on ${BASE}`);
    const out = docker(["exec", "-T", "daemon", "npx", "tsx", "tests/sim/provision.ts", cohort], true);
    const line = out.split("\n").find((l) => l.startsWith("SIM-COHORT:"));
    if (!line) die(`provisioning printed no cohort:\n${out}`);
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, line.slice("SIM-COHORT:".length), { mode: 0o600 });
    const state = loadState();
    console.log(`simulated board up: ${BASE}`);
    console.log(`  moderator (web UI login): ${state.moderator.id} / ${state.moderator.password}`);
    for (const [id, a] of Object.entries(state.agents)) console.log(`  agent ${id}: ${a.role} of ${a.project}`);
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

async function view(agents: string[]): Promise<void> {
    const state = loadState();
    const ids = agents.length > 0 ? agents : Object.keys(state.agents);
    for (const id of ids) {
        const seat = state.agents[id] ?? die(`no agent ${id} in the cohort`);
        // Scoped to the agent's project, as its MCP tools and its loop are: unscoped,
        // another project's ticket reads as actionable to an agent that never sees it.
        const open = await api<ViewRow[]>(seat.token, "GET", `/api/tickets?project=${encodeURIComponent(seat.project)}&open=1&limit=500`);
        const pings = await api<{ unread: number }>(seat.token, "GET", `/api/pings/count?consumer_id=${encodeURIComponent(id)}`);
        // The loop's own pick: its project's backlog, the first row not in cooldown.
        const backlog = await api<(ViewRow & { backlog_cooled_until?: string | null })[]>(
            seat.token, "GET", `/api/tickets?project=${encodeURIComponent(seat.project)}&backlog=1&limit=500&cooldown_sec=3600`);
        const head = backlog.find((r) => !r.backlog_cooled_until) ?? null;
        console.log(formatView(id, open, pings.unread, head));
        console.log("");
    }
}

async function pending(): Promise<void> {
    const state = loadState();
    const rows = await api<{ id: number; kind: string; ticket_id: number | null; by_agent: string; title: string | null; body: string | null }[]>(
        state.moderator.token, "GET", "/api/messages?status=pending&summary=1");
    if (rows.length === 0) return void console.log("nothing waits for the moderator");
    for (const m of rows) {
        const what = m.kind === "ticket_created" ? `ticket "${m.title}"` : `${m.kind} on #${m.ticket_id}`;
        console.log(`  ${m.id}  ${what} by ${m.by_agent}`);
    }
}

async function moderate(decision: "approve" | "reject", id: string | undefined): Promise<void> {
    if (!id || !/^\d+$/.test(id)) die(`usage: sim ${decision} <id>`, 2);
    const state = loadState();
    const m = await api<{ id: number; status: string }>(state.moderator.token, "POST", `/api/messages/${id}/${decision}`);
    console.log(`${m.id} is ${m.status}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
    case "up": await up(rest[0]); break;
    case "down": down(); break;
    case "mcp": await mcp(rest[0], rest[1], rest[2]); break;
    case "view": await view(rest); break;
    case "pending": await pending(); break;
    case "approve": await moderate("approve", rest[0]); break;
    case "reject": await moderate("reject", rest[0]); break;
    default: die("usage: sim up [cohort.yaml] | mcp <agent> <tool> [json] | view [agent...] | pending | approve <id> | reject <id> | down", 2);
}
