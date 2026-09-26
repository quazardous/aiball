/**
 * #3067 — projects on the bus: the list, one project's stats, its standing
 * prompt and critical ticket, registering, renaming and deleting one, and the
 * token usage a loop pushes onto it; with the presence facts an agent reads
 * before committing to something.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal } from "../methods.js";
import { flag } from "../params.js";
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
 * The projects. `detailed` adds each one's counters for `consumer_id`;
 * `landscape` (#379) its landscape hash, which only the loop asks for;
 * `project` (#2682) narrows a detailed answer to one.
 */
defineMethod({
    name: "project.list",
    who: ["human", "agent"],
    params: z.object({ detailed: flag, consumer_id: z.string().optional(), landscape: flag, project: z.string().optional() }),
    run: (_caller, p) => {
        if (p.detailed !== true) return listProjects();
        const all = listProjectsDetailed(p.consumer_id, p.landscape === true);
        return p.project ? all.filter((x) => x.name === p.project) : all;
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
