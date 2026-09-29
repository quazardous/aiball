/**
 * #3067 — projects on the bus: the list, one project's stats, its standing
 * prompt and critical ticket, registering, renaming and deleting one, and the
 * token usage a loop pushes onto it; with the presence facts an agent reads
 * before committing to something.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { isMachineLocal } from "../../machine-secret.js";
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal } from "../methods.js";
import { flag, remoteControl } from "../params.js";
import {
    addProjectTokenUsage,
    createProject,
    deleteProject,
    getPresenceFacts,
    getProject,
    getProjectStandingPrompt,
    getProjectStats,
    listProjects,
    listProjectsDetailed,
    renameProject,
} from "../../db.js";
import { getProjectWakeFocus } from "../../db/settings.js";
import { activeFocus, describeFocus } from "../../wake-focus.js";
import { focusRelatives } from "../../db/focus-relatives.js";
import { projectCriticalTicket } from "../../db/critical-ticket.js";
import { outboxPath } from "../../paths.js";
import { broadcast } from "../../ws.js";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ERROR_CODES } from "../../domain.js";
import { initFolder, InitRefusal } from "../../project-init.js";
import { patchForKey, readSettings, writeSettings } from "../../project-settings.js";

/** #2525 — the standing prompt, and the wake focus beside it. */
export function standingPromptView(project: string) {
    const focus = getProjectWakeFocus(project);
    const active = activeFocus(focus, Date.now(), focusRelatives);
    return {
        project,
        standing_prompt: getProjectStandingPrompt(project),
        focus_tickets: focus?.tickets ?? null,
        focus_until: focus?.until ?? null,
        // Past its end the stored focus no longer applies: the wake and the
        // filters read this, the form still shows what was typed.
        focus_active: active !== null,
        focus_line: describeFocus(active),
    };
}

/**
 * The projects. `detailed` adds each one's counters for `consumer_id`, and
 * (#3326) its standing prompt and whether a wake focus applies
 * (`standing_prompt`, `focus_active`, `focus_line`), read fresh: the counters'
 * cache would keep an edit out; `landscape` (#379) its landscape hash, which
 * only the loop asks for; `project` (#2682) narrows a detailed answer to one.
 */
defineMethod({
    name: "project.list",
    who: ["human", "agent"],
    params: z.object({ detailed: flag, consumer_id: z.string().optional(), landscape: flag, project: z.string().optional() }),
    run: (_caller, p) => {
        if (p.detailed !== true) return listProjects();
        const all = listProjectsDetailed(p.consumer_id, p.landscape === true);
        const some = p.project ? all.filter((x) => x.name === p.project) : all;
        return some.map((x) => {
            const s = standingPromptView(x.name);
            return { ...x, standing_prompt: s.standing_prompt, focus_active: s.focus_active, focus_line: s.focus_line };
        });
    },
});

/** Register a project (#B.216): it is listed before its first ticket. */
defineMethod({
    name: "project.create",
    who: ["human", "agent"],
    params: z.object({ name: z.unknown(), display_name: z.unknown().optional(), description: z.unknown().optional(), created_by: z.unknown().optional() }),
    run: (_caller, p) => {
        if (typeof p.name !== "string" || !p.name.trim()) throw new Refusal(400, "name is required");
        const name = p.name.trim();
        if (/\s/.test(name)) throw new Refusal(400, "name must not contain whitespace");
        if (getProject(name)) throw new Refusal(409, `project ${name} already exists`);
        return createProject({
            name,
            display_name: typeof p.display_name === "string" ? p.display_name : null,
            description: typeof p.description === "string" ? p.description : null,
            created_by: typeof p.created_by === "string" ? p.created_by : null,
        });
    },
});

/** A project's subscriber and content counts: the "nobody is listening" hint. */
defineMethod({
    name: "project.stats",
    who: ["human", "agent"],
    params: z.object({ name: z.string() }),
    run: (_caller, p) => getProjectStats(p.name),
});

/** #1832 — the project's standing instruction and wake focus, shown at the head of every wake. */
defineMethod({
    name: "project.standing_prompt",
    who: ["human", "agent"],
    params: z.object({ project: z.string().min(1) }),
    run: (_caller, p) => standingPromptView(p.project),
});

/** #2770 — the open ticket of the project holding back the most others. An indicator. */
defineMethod({
    name: "project.critical",
    who: ["human", "agent"],
    params: z.object({ project: z.string().min(1) }),
    run: (_caller, p) => ({ project: p.project, critical: projectCriticalTicket(p.project) }),
});

/** Delete a project and its messages; its outbox file goes with it. */
defineMethod({
    name: "project.delete",
    who: ["human", "agent"],
    params: z.object({ name: z.string() }),
    run: (_caller, p) => {
        const { deleted_messages } = deleteProject(p.name);
        // Best effort: the DB is the source of truth.
        try {
            const path = outboxPath(p.name);
            if (existsSync(path)) unlinkSync(path);
        } catch { /* ignore */ }
        broadcast({ type: "project_deleted", data: { project: p.name, deleted_messages } });
        return { project: p.name, deleted_messages, ok: true };
    },
});

/**
 * #699 — rename a project in every table that stores its name, and its
 * outbox file; the answer counts the rows each table changed.
 */
defineMethod({
    name: "project.rename",
    who: ["human", "agent"],
    params: z.object({ name: z.string(), new_name: z.unknown() }),
    run: (_caller, p) => {
        const newName = typeof p.new_name === "string" ? p.new_name : "";
        if (!newName) throw new Refusal(400, "new_name required (string)");
        let result: ReturnType<typeof renameProject>;
        try {
            result = renameProject(p.name, newName);
        } catch (e) {
            const msg = (e as Error).message ?? String(e);
            if (msg.includes("does not exist")) throw new Refusal(404, msg);
            if (msg.includes("already exists")) throw new Refusal(409, msg);
            throw new Refusal(400, msg);
        }
        try {
            const oldPath = outboxPath(p.name);
            if (existsSync(oldPath)) {
                writeFileSync(outboxPath(result.new_name), "");
                unlinkSync(oldPath);
            }
        } catch { /* best effort: the DB is the source of truth */ }
        broadcast({ type: "project_renamed", data: { old: result.old_name, new: result.new_name } });
        return { ...result, ok: true };
    },
});

/** #634 — add a turn's token usage to a project (the Stop hook's fallback when no ticket is marked). */
defineMethod({
    name: "project.add_token_usage",
    who: ["human", "agent"],
    params: z.object({ project: z.string().min(1), in: z.unknown().optional(), out: z.unknown().optional(), cache_w: z.unknown().optional(), cache_r: z.unknown().optional() }),
    run: (_caller, p) => {
        const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
        addProjectTokenUsage(p.project, { in: n(p.in), out: n(p.out), cacheW: n(p.cache_w), cacheR: n(p.cache_r) });
        return { project: p.project, ok: true };
    },
});

/**
 * #1819 — the facts an agent needs to judge whether a human is around, as
 * elapsed times, with no verdict: the threshold depends on what it is about
 * to commit.
 */
defineMethod({
    name: "consumer.presence",
    who: ["human", "agent"],
    params: z.object({ project: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()) }),
    run: (caller, p) => getPresenceFacts(consumerIdOf(caller), p.project),
});

/**
 * Set a folder up as a project, as `claude-loop init` does: its `.mcp.json`
 * and its `.aiball.yaml`, each patched in place when it exists. Answers what
 * happened to each file (`steps`, and `written` / `kept`), whether the project
 * is already on the board (not a refusal: a second folder or a crew joins a
 * known project), and whether the aiball skill is installed for Claude Code
 * (the method never installs it: it writes in the folder only). `dry_run`
 * answers the same without writing. A human's gesture, on this machine only:
 * the daemon writes in a folder the caller names, and a `.mcp.json` chooses
 * what Claude will run.
 */
defineMethod({
    name: "project.init",
    who: ["human"],
    machine: true,
    params: z.object({
        cwd: z.string(),
        project: z.string().optional(),
        agent: z.string().optional(),
        role: z.enum(["lead", "crew"]).optional(),
        private: z.boolean().optional(),
        no_claim: z.boolean().optional(),
        force: z.boolean().optional(),
        dry_run: z.boolean().optional(),
    }),
    run: (caller, p) => {
        const steps = inFolder(caller, p.cwd, () => initFolder({
            cwd: p.cwd,
            project: p.project,
            agent: p.agent,
            role: p.role,
            private: p.private,
            noClaim: p.no_claim,
            force: p.force,
            dryRun: p.dry_run,
        }));
        return {
            cwd: p.cwd,
            dry_run: p.dry_run === true,
            steps,
            written: [...new Set(steps.filter((s) => s.action !== "kept").map((s) => s.file))],
            kept: [...new Set(steps.filter((s) => s.action === "kept").map((s) => s.file))],
            project_exists: p.project ? getProject(p.project) !== undefined : null,
            skill: existsSync(join(homedir(), ".claude", "skills", "aiball", "SKILL.md")) ? "installed" : "missing",
        };
    },
});

/** #3208 / #3256 — a folder of this machine: local callers only, an absolute path; a refusal of the folder's own as the bus says it. */
function inFolder<T>(caller: { transport: string }, cwd: string, f: () => T): T {
    if (!isMachineLocal(caller)) throw new Refusal(403, "a folder of this machine: local callers only", ERROR_CODES.FORBIDDEN);
    if (!isAbsolute(cwd)) throw new Refusal(400, `cwd must be an absolute path (got '${cwd}')`, ERROR_CODES.BAD_REQUEST);
    try {
        return f();
    } catch (e) {
        if (e instanceof InitRefusal) throw new Refusal(e.status, e.message, ERROR_CODES[e.code]);
        throw e;
    }
}

/**
 * The settings a client may show for a folder's project, as a loop started
 * there would get them: each one's value and where it comes from (`from`),
 * and `file`, the `.aiball.yaml` that loop reads (the nearest one up the tree;
 * null without one, `configured` false). #3305 — the identity (`consumer`:
 * project, agent, role), where it runs (`session`) and `remote_control`,
 * Claude's Remote Control: what a client setting the folder up starts from. A
 * human's gesture, on this machine only.
 */
defineMethod({
    name: "project.settings",
    who: ["human"],
    machine: true,
    params: z.object({ cwd: z.string() }),
    run: (caller, p) => inFolder(caller, p.cwd, () => readSettings(p.cwd)),
});

/**
 * Change settings of a folder's project, in the `.aiball.yaml` a loop started
 * there reads, patched in place (its other keys and its comments stay), and
 * answer them as `project.settings` does. `remote_control`: true, false or a
 * name; `session`: host or tmux; null removes either, and the layer below
 * applies again. The next start reads
 * it; a loop that runs keeps what it started with. A folder without a
 * `.aiball.yaml` is refused (`CONFLICT`: set it up with `project.init`). A
 * human's gesture, on this machine only.
 */
defineMethod({
    name: "project.settings_set",
    who: ["human"],
    machine: true,
    params: z.object({
        cwd: z.string(),
        remote_control: remoteControl.nullable().optional(),
        /** #3305 — where the folder's loops run: `host`, `tmux`, or null for the layer below. */
        session: z.enum(["host", "tmux"]).nullable().optional(),
        /** #3308 — any setting `project.settings` describes, by its key; `value` null for the layer below. */
        key: z.string().optional(),
        value: z.unknown().optional(),
    }),
    run: (caller, p) => inFolder(caller, p.cwd, () => writeSettings(p.cwd, {
        remote_control: p.remote_control, session: p.session,
        ...(p.key !== undefined ? patchForKey(p.key, p.value === undefined ? null : p.value) : {}),
    })),
});
