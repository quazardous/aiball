/**
 * #3360 — what `claude-loop start` refuses so that two agents never share a
 * folder's conversation: BookShepherd-claude, restarted with the aiball loop's
 * AIBALL_CWD, ran in aiball's folder and resumed claude-aiball-dev's
 * conversation — two Claudes on one conversation.
 */
import { existsSync, readdirSync } from "node:fs";
import { readPlate, stateDirFor, STATE_ROOT, type Plate } from "./state.js";

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
