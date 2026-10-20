/**
 * #3360 — what `claude-loop start` refuses so that two agents never share a
 * folder's conversation: BookShepherd-claude, restarted with the aiball loop's
 * AIBALL_CWD, ran in aiball's folder and resumed claude-aiball-dev's
 * conversation — two Claudes on one conversation.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readPlate, stateDirFor, STATE_ROOT, type Plate } from "./state.js";

/**
 * The folder the command was typed in. The launcher records it before it moves
 * into the install root, so `process.cwd()` is no longer it by the time the CLI
 * runs. Read once and dropped from the environment: a process started from this
 * one must not take it for its own. Without the launcher, this process's folder.
 */
export function takeLaunchCwd(env: NodeJS.ProcessEnv = process.env): string {
    const recorded = env.AIBALL_LAUNCH_CWD;
    delete env.AIBALL_LAUNCH_CWD;
    return recorded || process.cwd();
}

/** The folder a loop starts in: `--cwd`, relative to where the command was typed, else that folder. */
export function startFolder(optCwd: string | undefined, launchCwd: string): string {
    return optCwd ? resolve(launchCwd, optCwd) : launchCwd;
}

/** A folder whose .aiball.yaml names its agent runs that agent, or a crew of it. Null: allowed. */
export function foreignAgentRefusal(o: { agent: string | undefined; folderAgent: string; agentSource: string; role: string | undefined; cwd: string }): string | null {
    if (!o.agent || o.agent === o.folderAgent || o.agentSource !== "aiball.yaml" || o.role === "crew") return null;
    return `${o.agent} does not run in ${o.cwd}: its .aiball.yaml is ${o.folderAgent}'s. Start ${o.agent} from its own folder (--cwd), or here as a crew agent (--crew ${o.agent}).`;
}

/** The running loop of ANOTHER agent that holds conversation `id`, if any. */
export function conversationHolder(
    id: string,
    agent: string | undefined,
    alive: (name: string) => boolean,
    root: string = STATE_ROOT,
    plateOf: (name: string) => Plate = (name) => readPlate(stateDirFor(name)),
): { name: string; agent: string } | null {
    if (!existsSync(root)) return null;
    for (const name of readdirSync(root)) {
        if (name.startsWith(".")) continue;
        let plate: Plate;
        try { plate = plateOf(name); } catch { continue; }
        const holder = plate.agent ?? plate.consumer ?? plate.host_agent ?? null;
        if (plate.session_id !== id || !holder || holder === agent) continue;
        if (alive(name)) return { name, agent: holder };
    }
    return null;
}

/**
 * #4120 — a Claude config dir the project chose but that never finished Claude's
 * first run (theme, login, …): those screens wait for a person, and a detached
 * loop would sit on them — or get wakes typed into them. Null: allowed. Only a
 * dir the project names is checked; the environment's and ~/.claude are the
 * user's own, as before.
 */
export function configDirRefusal(c: { dir: string; json: string; from: string }, readJson: (file: string) => string | null): string | null {
    if (c.from !== "file") return null;
    let done = false;
    const text = readJson(c.json);
    if (text !== null) {
        try { done = (JSON.parse(text) as { hasCompletedOnboarding?: unknown }).hasCompletedOnboarding === true; } catch { /* unreadable: not done */ }
    }
    if (done) return null;
    return `the Claude config dir ${c.dir} (claude.config_dir) has not been through Claude's first run yet (theme, login): `
        + `a loop cannot answer those screens. Run it once by hand — CLAUDE_CONFIG_DIR=${c.dir} claude — then start again.`;
}
