/**
 * #3068 — the board's settings and housekeeping on the bus: the moderation
 * strategy (global and per project), a project's standing prompt and wake
 * focus, its rich stats, purging old closed tickets, the daemon's info zone,
 * the token series, the config manager's overrides (#449), and the processes
 * a moderator may start on the daemon's host: a project's loop, a launcher.
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal } from "../methods.js";
import { standingPromptView } from "./project.js";
import {
    captureTokenSnapshotIfDue,
    deleteConfigOverride,
    getGlobalCounts,
    getProjectStatsRich,
    getProjectStrategy,
    getResolvedConfig,
    getStrategy,
    getTokenTimeseries,
    isHuman,
    isRootActive,
    listProjects,
    listProjectsDetailed,
    purgeOldClosedTickets,
    setConfigOverride,
    setProjectStandingPrompt,
    setProjectStrategy,
    setStrategy,
    STRATEGIES,
    type Strategy,
} from "../../db.js";
import { projectTicketStates } from "../../db/inbox-agg.js";
import { setProjectWakeFocus } from "../../db/settings.js";
import { listTicketIdsInProject } from "../../db/tickets.js";
import { parseFocusTickets } from "../../wake-focus.js";
import { allowsGlobalOverride, allowsProjectOverride, coerceConfigValue, getSchemaEntry } from "../../config/schema.js";
import { AIBALL_HOME, DB_PATH, UPLOADS_DIR } from "../../paths.js";
import { AIBALL_VERSION } from "../../version.js";
import { broadcast } from "../../ws.js";
import { installRoot } from "../../claude-loop/state.js";
import { getLauncher, loadLaunchers } from "../../launchers.js";
import { ERROR_CODES } from "../../domain.js";

function strategyOf(s: unknown, nullable: boolean): Strategy | null {
    if (nullable && (s === null || s === undefined)) return null;
    if (typeof s !== "string" || !(STRATEGIES as readonly string[]).includes(s)) {
        throw new Refusal(400, `strategy must be one of ${STRATEGIES.join(", ")}${nullable ? " or null" : ""}`);
    }
    return s as Strategy;
}

const project = z.string().min(1);

/** The moderation strategy of the whole board. */
defineMethod({
    name: "strategy.get",
    who: ["human", "agent"],
    params: z.object({}),
    run: () => ({ strategy: getStrategy() }),
});

/** Set the board's moderation strategy; every open board hears of it. */
defineMethod({
    name: "strategy.set",
    who: ["human", "agent"],
    params: z.object({ strategy: z.unknown() }),
    run: (_caller, p) => {
        const s = strategyOf(p.strategy, false)!;
        setStrategy(s);
        broadcast({ type: "strategy_changed", data: { strategy: s } });
        return { strategy: s };
    },
});

/** #B.127 — a project's own strategy, or null when it follows the board's; the board's beside it. */
defineMethod({
    name: "project.strategy",
    who: ["human", "agent"],
    params: z.object({ project }),
    run: (_caller, p) => ({ project: p.project, strategy: getProjectStrategy(p.project), global: getStrategy() }),
});

/** Set a project's strategy; null clears it, and the project follows the board's again. */
defineMethod({
    name: "project.set_strategy",
    who: ["human", "agent"],
    params: z.object({ project, strategy: z.unknown().optional() }),
    run: (_caller, p) => {
        const s = strategyOf(p.strategy, true);
        setProjectStrategy(p.project, s);
        broadcast({ type: "strategy_changed", data: { project: p.project, strategy: s } });
        return { project: p.project, strategy: s, global: getStrategy() };
    },
});

/**
 * #1832 — set a project's standing instruction (null or empty clears it),
 * and #2525 its wake focus: `focus_tickets` is checked whole, every ticket
 * must belong to the project, before anything is written. No length cap: the
 * UI's one-line input is what keeps it short. No broadcast: it changes what
 * the next wake says, edited from one page that re-reads on load.
 */
defineMethod({
    name: "project.set_standing_prompt",
    who: ["human", "agent"],
    params: z.object({ project, standing_prompt: z.unknown().optional(), focus_tickets: z.unknown().optional(), focus_until: z.unknown().optional() }),
    run: (_caller, p) => {
        const v = p.standing_prompt;
        if (v !== null && v !== undefined && typeof v !== "string") throw new Refusal(400, "standing_prompt must be a string or null");
        const raw = p as Record<string, unknown>;
        const hasFocus = "focus_tickets" in raw || "focus_until" in raw;
        let nextFocus: { tickets: string; until: string | null } | null = null;
        if (hasFocus) {
            const tickets = p.focus_tickets;
            const until = p.focus_until;
            if (tickets !== null && tickets !== undefined && typeof tickets !== "string") throw new Refusal(400, "focus_tickets must be a string or null");
            if (until !== null && until !== undefined && (typeof until !== "string" || !Number.isFinite(Date.parse(until)))) {
                throw new Refusal(400, "focus_until must be an ISO date or null");
            }
            if (typeof tickets === "string" && tickets.trim()) {
                const parsed = parseFocusTickets(tickets);
                if ("error" in parsed) throw new Refusal(400, parsed.error);
                const known = new Set(listTicketIdsInProject(p.project, parsed.ids));
                const foreign = parsed.ids.filter((id) => !known.has(id));
                if (foreign.length) throw new Refusal(400, `not a ticket of ${p.project}: ${foreign.map((id) => `#${id}`).join(", ")}`);
                nextFocus = { tickets: tickets.trim(), until: typeof until === "string" ? new Date(until).toISOString() : null };
            }
        }
        if (v !== undefined) setProjectStandingPrompt(p.project, (v as string | null) ?? null);
        if (hasFocus) setProjectWakeFocus(p.project, nextFocus);
        return standingPromptView(p.project);
    },
});

/** A project's dashboard: pulse, live counts and top-N aggregates. */
defineMethod({
    name: "project.stats_rich",
    who: ["human", "agent"],
    params: z.object({ name: project }),
    run: (_caller, p) => getProjectStatsRich(p.name, projectTicketStates(p.name)),
});

function purgeDays(v: unknown): number {
    return typeof v === "number" && v > 0 ? Math.floor(v) : 365;
}

/** Delete a project's tickets closed for longer than `older_than_days` (365 by default). */
defineMethod({
    name: "project.purge",
    who: ["human", "agent"],
    params: z.object({ name: project, older_than_days: z.unknown().optional() }),
    run: (_caller, p) => {
        const days = purgeDays(p.older_than_days);
        const result = purgeOldClosedTickets(p.name, days);
        if (result.purged_tickets > 0) {
            broadcast({ type: "project_purged", data: { project: p.name, ...result, older_than_days: days } });
        }
        return { project: p.name, older_than_days: days, ...result, ok: true };
    },
});

/** #475 — the same purge over every project, one `project_purged` event per project touched. */
defineMethod({
    name: "board.purge",
    who: ["human", "agent"],
    params: z.object({ older_than_days: z.unknown().optional() }),
    run: (_caller, p) => {
        const days = purgeDays(p.older_than_days);
        const per_project: Array<{ project: string; purged_tickets: number; purged_messages: number }> = [];
        let purged_tickets = 0;
        let purged_messages = 0;
        for (const name of listProjects()) {
            const r = purgeOldClosedTickets(name, days);
            if (r.purged_tickets > 0) broadcast({ type: "project_purged", data: { project: name, ...r, older_than_days: days } });
            per_project.push({ project: name, ...r });
            purged_tickets += r.purged_tickets;
            purged_messages += r.purged_messages;
        }
        return { older_than_days: days, purged_tickets, purged_messages, per_project, ok: true };
    },
});

function dirSize(path: string): { bytes: number; files: number } {
    let bytes = 0;
    let files = 0;
    try {
        for (const ent of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, ent.name);
            if (ent.isDirectory()) {
                const sub = dirSize(child);
                bytes += sub.bytes;
                files += sub.files;
            } else if (ent.isFile()) {
                try { bytes += statSync(child).size; files += 1; } catch { /* the file went away meanwhile */ }
            }
        }
    } catch { /* no directory: zeros */ }
    return { bytes, files };
}

/** #476 — the daemon's info zone: version, uptime, the database and uploads sizes, global counts. */
defineMethod({
    name: "board.info",
    who: ["human", "agent"],
    params: z.object({}),
    run: () => {
        let dbBytes = 0;
        try { dbBytes = statSync(DB_PATH).size; } catch { /* no database file: 0 */ }
        const uploads = dirSize(UPLOADS_DIR);
        return {
            version: AIBALL_VERSION,
            uptime_sec: Math.floor(process.uptime()),
            home: AIBALL_HOME,
            db: { path: DB_PATH, bytes: dbBytes },
            uploads: { path: UPLOADS_DIR, bytes: uploads.bytes, files: uploads.files },
            counts: getGlobalCounts(),
            ts: new Date().toISOString(),
        };
    },
});

/**
 * #1200 — token usage over time, per project. Takes a snapshot first when the
 * throttle allows, so the series fills even without a boot job.
 */
defineMethod({
    name: "token_usage.timeseries",
    who: ["human", "agent"],
    params: z.object({ project: z.string().optional(), days: z.coerce.number().optional() }),
    run: (_caller, p) => {
        captureTokenSnapshotIfDue();
        const sinceMs = p.days !== undefined && Number.isFinite(p.days) && p.days > 0 ? Date.now() - p.days * 86_400_000 : undefined;
        return { series: getTokenTimeseries({ project: p.project, sinceMs }) };
    },
});

/**
 * #1550 — the config manager owns database overrides only; a key read only
 * from `.aiball.yaml` would take an override the runtime never reads.
 */
function editableEntry(key: string) {
    const entry = getSchemaEntry(key);
    if (!entry) throw new Refusal(404, `unknown config key '${key}'`);
    if (!(entry.sources ?? ["db"]).includes("db")) {
        throw new Refusal(400, `key '${key}' is file-sourced (.aiball.yaml) — not editable via the DB config manager`);
    }
    return entry;
}

const layer = z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().optional());

/** #449 — the config as resolved (schema, layers, effective value), for a project or the whole board. */
defineMethod({
    name: "config.managed",
    who: ["human", "agent"],
    params: z.object({ project: layer }),
    run: (_caller, p) => {
        const proj = p.project || null;
        return { project: proj, config: getResolvedConfig(proj) };
    },
});

/** Set an override, on the board or a project as the key's scope allows; a protected key is a human's to set. */
defineMethod({
    name: "config.set",
    who: ["human", "agent"],
    params: z.object({ key: z.string(), value: z.unknown().optional(), project: z.unknown().optional() }),
    run: (caller, p) => {
        const entry = editableEntry(p.key);
        const proj = typeof p.project === "string" ? p.project.trim() : ""; // '' is the board's layer
        if (proj === "" && !allowsGlobalOverride(entry)) throw new Refusal(400, `key '${p.key}' has no global value (scope=${entry.scope}) — set it per project`);
        if (proj !== "" && !allowsProjectOverride(entry)) throw new Refusal(400, `key '${p.key}' is not project-overridable (scope=${entry.scope})`);
        const me = consumerIdOf(caller);
        if (entry.protected && !isHuman(me)) throw new Refusal(403, `config key '${p.key}' is protected (moderator-only)`, ERROR_CODES.MODERATOR_ONLY);
        const value = coerceConfigValue(entry, p.value);
        if (value === null) {
            throw new Refusal(400, `invalid value for '${p.key}' (type ${entry.type}${entry.options ? `, one of ${entry.options.join("|")}` : ""})`);
        }
        setConfigOverride(proj, p.key, value, me);
        return { key: p.key, project: proj || null, value };
    },
});

/** Clear an override: the layer below applies again. */
defineMethod({
    name: "config.clear",
    who: ["human", "agent"],
    params: z.object({ key: z.string(), project: layer }),
    run: (caller, p) => {
        const entry = editableEntry(p.key);
        if (entry.protected && !isHuman(consumerIdOf(caller))) {
            throw new Refusal(403, `config key '${p.key}' is protected (moderator-only)`, ERROR_CODES.MODERATOR_ONLY);
        }
        deleteConfigOverride(p.project ?? "", p.key);
        return { key: p.key, project: p.project || null, cleared: true };
    },
});

/**
 * Start a process on the daemon's host, detached. A spawn that fails is an
 * 'error' event on the child: unheard, it would end the daemon (#3103).
 */
function spawnDetached(cmd: string, args: string[], what: string, cwd?: string): number | undefined {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", ...(cwd ? { cwd } : {}) });
    child.on("error", (e) => console.error(`[launch] ${what} failed: ${e.message}`));
    child.unref();
    return child.pid;
}

/**
 * #393 — start a claude-loop for a project, at one of the roots it has run
 * at (never an arbitrary path), on this daemon's host, detached. It spawns a
 * process: a human's gesture. One loop per root.
 */
defineMethod({
    name: "project.launch",
    who: ["human"],
    denied: { message: "launch is human-only — it spawns a claude-loop process", code: ERROR_CODES.MODERATOR_ONLY },
    params: z.object({ name: project, root: z.unknown().optional() }),
    run: (_caller, p) => {
        const root = typeof p.root === "string" ? p.root : "";
        const knownRoots = listProjectsDetailed().find((x) => x.name === p.name)?.roots ?? [];
        if (!root || !knownRoots.includes(root)) {
            throw new Refusal(400, `root must be one of this project's known local roots: ${JSON.stringify(knownRoots)}`);
        }
        if (isRootActive(root)) throw new Refusal(409, "a claude-loop is already running for this root");
        const pid = spawnDetached(join(installRoot(), "bin", "claude-loop"), ["start", "--cwd", root, "--no-attach"], `claude-loop for ${root}`);
        if (pid === undefined) throw new Refusal(500, "failed to launch claude-loop");
        return { ok: true, project: p.name, root, pid };
    },
});

/** #398 — the launchers the operator declared in config: the only commands the API can start. */
defineMethod({
    name: "launcher.list",
    who: ["human", "agent"],
    params: z.object({}),
    run: () => loadLaunchers(),
});

/**
 * #398 — run a declared launcher by id, detached; its command and arguments
 * come from the config, never from the call. A human's gesture.
 */
defineMethod({
    name: "launcher.run",
    who: ["human"],
    denied: { message: "launchers are human-only — they spawn a process on the daemon host", code: ERROR_CODES.MODERATOR_ONLY },
    params: z.object({ id: z.string() }),
    run: (_caller, p) => {
        const launcher = getLauncher(p.id);
        if (!launcher) throw new Refusal(404, `no launcher with id '${p.id}' (declared in config?)`);
        const pid = spawnDetached(launcher.cmd, launcher.args ?? [], `launcher ${launcher.id}`, launcher.cwd);
        if (pid === undefined) throw new Refusal(500, `failed to launch '${launcher.id}'`);
        return { ok: true, id: launcher.id, label: launcher.label, pid };
    },
});
