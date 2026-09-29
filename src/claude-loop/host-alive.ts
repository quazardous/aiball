/**
 * #3066 — whether a loop moved onto the daemon's session host still runs. Such
 * a loop has no tmux session, so the tmux probe calls it dead; its plate names
 * the agent it runs as (`host_agent`), and the host writes its pid beside its
 * sockets (`host.json`). Read on this machine only: a loop is started where
 * its host runs. #3166 — in the folder the daemon gave at start (`host_dir` on
 * the plate): the daemon's home, which the loop's own need not be (a loop that
 * reaches its daemon by `AIBALL_SOCK` alone). A plate from before it: the
 * folder the loop's home would give.
 */
import { hostDirName } from "../session-dir.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIBALL_HOME } from "../paths.js";
import { readPlate, type Plate } from "./state.js";
import { AiballClient } from "../client.js";

/** The agent the loop at `sd` runs as on the host, when that host is alive; otherwise null. */
export function liveHostAgent(sd: string, home: string = AIBALL_HOME): string | null {
    let plate: Plate;
    try {
        plate = readPlate(sd);
    } catch {
        return null;
    }
    const agent = plate.host_agent;
    if (!agent) return null;
    try {
        const info = JSON.parse(readFileSync(join(hostDirOf(plate, agent, home), "host.json"), "utf8")) as { pid?: unknown };
        if (typeof info.pid !== "number") return null;
        process.kill(info.pid, 0);
        return agent;
    } catch {
        return null;
    }
}

/** The socket a terminal attaches to, for the loop at `sd` on the host. */
export function hostAttachSocket(sd: string, agent: string, home: string = AIBALL_HOME): string {
    let plate: Plate | null = null;
    try { plate = readPlate(sd); } catch { /* no plate: the home's folder */ }
    return join(hostDirOf(plate, agent, home), "attach.sock");
}

/** The host's folder: the one the daemon gave (`host_dir`), else the one this home would give. */
function hostDirOf(plate: Pick<Plate, "host_dir"> | null, agent: string, home: string): string {
    return plate?.host_dir ?? join(home, "hosts", hostDirName({ agent }, join(home, "hosts")));
}

/**
 * A loop is alive in its tmux session, or on the daemon's session host (no
 * tmux session there: its host still runs). Every "is it dead?" that deletes,
 * reuses or prunes a loop's state asks this, never tmux alone.
 */
export function loopAlive(sd: string, tmuxAlive: () => boolean, home: string = AIBALL_HOME): boolean {
    return tmuxAlive() || liveHostAgent(sd, home) !== null;
}

/**
 * #3246 — the agents whose session runs on the daemon's host, as the daemon
 * says (`session.list`): agent → its attach socket (null when it gives none);
 * null when the daemon does not answer. The host's files may sit in a home
 * this process does not share: every "is it dead?" of the CLI asks this too,
 * or it takes such a loop for dead (#3166, #3239).
 */
export async function daemonHostedAgents(agent: string | null = null): Promise<Map<string, string | null> | null> {
    try {
        const sessions = await new AiballClient({ agentId: agent ?? undefined }).sessionList();
        return new Map(sessions.filter((s) => s.agent && s.running !== false).map((s) => [s.agent!, s.attach?.socket ?? null]));
    } catch {
        return null;
    }
}

/** Whether the loop at `sd` runs on the daemon's host, by `hosted` (daemonHostedAgents). */
export function hostedByDaemon(sd: string, hosted: Map<string, string | null> | null): boolean {
    if (!hosted) return false;
    try {
        const agent = readPlate(sd).host_agent;
        return !!agent && hosted.has(agent);
    } catch {
        return false;
    }
}
