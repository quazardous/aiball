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
    listConsumers,
    renameProject,
} from "../../db.js";
import { relocateConsumerRoots } from "../../db/projects.js";
import { getProjectWakeFocus } from "../../db/settings.js";
import { activeFocus, describeFocus } from "../../wake-focus.js";
import { focusRelatives } from "../../db/focus-relatives.js";
import { projectCriticalTicket } from "../../db/critical-ticket.js";
import { outboxPath } from "../../paths.js";
import { broadcast } from "../../ws.js";
import { projectRenamed } from "./subjects.js";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ERROR_CODES } from "../../domain.js";
import { initFolder, InitRefusal } from "../../project-init.js";
import { patchForKey, readSettings, writeSettings } from "../../project-settings.js";
import { loopsOnAnotherConfigDir } from "./loop.js";
import { claudeConfigDir, configDirState, expandConfigDir, sourceDir } from "../../claude-config-dir.js";
import { forkClaudeConfig } from "../../claude-config-fork.js";
import { claudeRunningIn, moveClaudeSessions, sessionsWire } from "../../claude-config-move.js";

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

/** #3780 — each of these consumers' entry changed: `agent.<id>.state` (and the board) hear it. */
function agentsChanged(ids: string[]): void {
    for (const consumer_id of ids) broadcast({ type: "consumer_changed", data: { consumer_id } });
}

/** The rename itself, its broadcast and its rows moved in the views. #3765 — shared by `project.rename` and `project.rename_all`. */
function renameEverywhere(name: string, newName: string) {
    let result: ReturnType<typeof renameProject>;
    try {
        result = renameProject(name, newName);
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (msg.includes("does not exist")) throw new Refusal(404, msg);
        if (msg.includes("already exists")) throw new Refusal(409, msg);
        throw new Refusal(400, msg);
    }
    try {
        const oldPath = outboxPath(name);
        if (existsSync(oldPath)) {
            writeFileSync(outboxPath(result.new_name), "");
            unlinkSync(oldPath);
        }
    } catch { /* best effort: the DB is the source of truth */ }
    broadcast({ type: "project_renamed", data: { old: result.old_name, new: result.new_name } });
    // #3764 — and the views of the tickets hear each of them under its new name.
    projectRenamed(result.new_name);
    // #3780 — and its agents: their entry (agent.<id>.state) names the new project.
    agentsChanged(listConsumers().filter((c) => c.project === result.new_name).map((c) => c.consumer_id));
    return result;
}

/** #699 — rename a project in every table that stores its name, and its outbox file; the answer counts the rows each table changed. */
defineMethod({
    name: "project.rename",
    who: ["human", "agent"],
    params: z.object({ name: z.string(), new_name: z.unknown() }),
    run: (_caller, p) => {
        const newName = typeof p.new_name === "string" ? p.new_name : "";
        if (!newName) throw new Refusal(400, "new_name required (string)");
        return { ...renameEverywhere(p.name, newName), ok: true };
    },
});

/**
 * #3765 — `aiball project rename-all` on the bus: the name, `.aiball.yaml` and
 * the folder, planned and applied by the same rules (src/project-rename.ts).
 * The folder is the project's root as its loops pushed it; with several or
 * none, the refusal lists the known ones and `cwd` names it. A human's
 * gesture, on this machine only. Dry run unless `apply`.
 */
defineMethod({
    name: "project.rename_all",
    who: ["human"],
    machine: true,
    params: z.object({
        name: z.string().min(1),
        new_name: z.string().min(1),
        cwd: z.string().optional(),
        dir: z.string().optional(),
        no_move: z.boolean().optional(),
        apply: z.boolean().optional(),
    }),
    run: async (caller, p) => {
        if (!isMachineLocal(caller)) throw new Refusal(403, "a folder of this machine: local callers only", ERROR_CODES.FORBIDDEN);
        for (const [key, value] of [["cwd", p.cwd], ["dir", p.dir]] as const) {
            if (value !== undefined && !isAbsolute(value)) throw new Refusal(400, `${key} must be an absolute path (got '${value}')`, ERROR_CODES.BAD_REQUEST);
        }
        let from = p.cwd;
        if (from === undefined) {
            // A rename already half done (the old name gone) knows its root under the new name.
            const known = listProjects().includes(p.name) ? p.name : p.new_name;
            // A loop on another machine (a node) pushes its root too: only this machine's count here.
            const roots = [...new Set(listProjectsDetailed().filter((x) => x.name === known).flatMap((x) => x.roots ?? []))].filter((r) => isAbsolute(r));
            if (roots.length !== 1) {
                throw roots.length === 0
                    ? new Refusal(409, `no folder is known for project "${p.name}" — pass cwd`, ERROR_CODES.NO_ROOT, { roots })
                    : new Refusal(409, `project "${p.name}" is known in several folders (${roots.join(", ")}) — pass cwd`, ERROR_CODES.AMBIGUOUS_ROOT, { roots });
            }
            from = roots[0];
        }
        // #3765 — the machine's reads and writes in a worker: Claude's history can be hundreds of MB.
        const { inWorker } = await import("../../project-rename-worker.js");
        const plan = await inWorker({ op: "plan", input: { oldName: p.name, newName: p.new_name, from, dir: p.dir, noMove: p.no_move === true }, names: listProjects() });
        const view = {
            db: plan.db,
            yaml: plan.yaml,
            folder: plan.relocate ? { from: plan.relocate.old, to: plan.relocate.new, mode: plan.relocate.mode } : null,
        };
        if (p.apply !== true || plan.blockers.length > 0) return { applied: false, plan: view, blockers: plan.blockers };
        const renamed = plan.db === "rename" ? renameEverywhere(p.name, p.new_name) : null;
        const files = await inWorker({ op: "apply", plan });
        const result = { ...files, renamed };
        // The roots the loops pushed follow the folder.
        const moved = plan.relocate ? relocateConsumerRoots(plan.relocate.old, plan.relocate.new) : [];
        // #3780 — their entry carries the folder too.
        agentsChanged(moved);
        const roots = moved.length;
        return { applied: true, plan: view, blockers: [], result: { ...result, roots } };
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
    params: z.object({
        cwd: z.string(),
        /** #4222 — a config dir the client is about to choose: its state comes back as `candidate`, nothing written. */
        config_dir: z.string().optional(),
    }),
    run: (caller, p) => inFolder(caller, p.cwd, () => {
        const settings = readSettings(p.cwd);
        if (p.config_dir === undefined) return settings;
        if (!p.config_dir.trim() || /[\r\n\0]/.test(p.config_dir)) {
            throw new Refusal(400, "config_dir takes a directory path", ERROR_CODES.BAD_REQUEST);
        }
        // Expanded as claude.config_dir is; ~/.claude keeps its .claude.json in the home.
        const dir = sourceDir(expandConfigDir(p.config_dir, p.cwd));
        return { ...settings, candidate: { dir: dir.dir, state: configDirState(dir) } };
    }),
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
        /** #4209 — with a new `claude.config_dir`: start it as `aiball claude-config --fork` does. */
        fork: z.object({
            /** The dir to fork from; default the folder's dir before the change. */
            from: z.string().optional(),
            /** Copy everything instead of linking. */
            copy: z.boolean().optional(),
            /** Replace what the new dir has; its own entries are moved aside, never deleted. */
            force: z.boolean().optional(),
        }).optional(),
        /**
         * #4419 — with a change of `claude.config_dir` (a path, or null for the
         * layer below): the folder's Claude sessions follow, as
         * `aiball claude-config --move-sessions` does. Refused while a Claude runs there.
         */
        move_sessions: z.boolean().optional(),
    }),
    run: (caller, p) => inFolder(caller, p.cwd, () => {
        const patch = {
            remote_control: p.remote_control, session: p.session,
            ...(p.key !== undefined ? patchForKey(p.key, p.value === undefined ? null : p.value) : {}),
        };
        // #4209 — a fork starts a new dir: only with one.
        if (p.fork && typeof patch.config_dir !== "string") {
            throw new Refusal(400, "fork comes with a new claude.config_dir (key claude.config_dir, a path)", ERROR_CODES.BAD_REQUEST);
        }
        // #4419 — moving the sessions comes with a change of dir, and never under a running Claude.
        if (p.move_sessions && patch.config_dir === undefined) {
            throw new Refusal(400, "move_sessions comes with a change of claude.config_dir (key claude.config_dir)", ERROR_CODES.BAD_REQUEST);
        }
        const busy = p.move_sessions ? claudeRunningIn(p.cwd) : null;
        if (busy && busy.length > 0) {
            throw new Refusal(409, `Claude runs in ${p.cwd} (${busy.map((b) => b.pid).join(", ")}): stop its loops before moving its sessions`, ERROR_CODES.CLAUDE_RUNS_IN_FOLDER, { folder: p.cwd, pids: busy });
        }
        const before = claudeConfigDir(p.cwd);
        const settings = writeSettings(p.cwd, patch);
        // #4120 — a new Claude config dir reaches a running loop only at its
        // restart: say which loops run on another one, for the client to offer it.
        if (patch.config_dir === undefined) return settings;
        const restart = loopsOnAnotherConfigDir(p.cwd, settings.config_dir.value);
        const to = claudeConfigDir(p.cwd);
        const move = p.move_sessions && to.dir !== before.dir ? moveClaudeSessions(p.cwd, before, to) : null;
        const out = {
            ...settings, restart_needed: restart.length > 0, restart_loops: restart,
            ...(p.move_sessions ? { sessions: move && { ...sessionsWire(move), checked: busy !== null } } : {}),
        };
        if (!p.fork) return out;
        const from = p.fork.from !== undefined ? sourceDir(expandConfigDir(p.fork.from, p.cwd)) : before;
        if (from.dir === to.dir) return { ...out, fork: null };
        const f = forkClaudeConfig(from, to, { copy: p.fork.copy, force: p.fork.force });
        return {
            ...out,
            // The new dir has changed: its state again.
            config_dir_state: configDirState(to),
            fork: { from: from.dir, linked: f.linked, copied: f.copied, kept: f.kept, moved_aside: f.movedAside, unknown: f.unknown, mcp_servers: f.mcpServers },
        };
    }),
});
