/**
 * #3066 — whether a loop moved onto the daemon's session host still runs. Such
 * a loop has no tmux session, so the tmux probe calls it dead; its plate names
 * the agent it runs as (`host_agent`), and the host writes its pid beside its
 * sockets (`$AIBALL_HOME/hosts/<agent>/host.json`). Read on this machine only:
 * a loop is started where its host runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIBALL_HOME } from "../paths.js";
import { readPlate } from "./state.js";

/** The agent the loop at `sd` runs as on the host, when that host is alive; otherwise null. */
export function liveHostAgent(sd: string, home: string = AIBALL_HOME): string | null {
    let agent: string | null | undefined;
    try {
        agent = readPlate(sd).host_agent;
    } catch {
        return null;
    }
    if (!agent) return null;
    try {
        const info = JSON.parse(readFileSync(join(home, "hosts", agent, "host.json"), "utf8")) as { pid?: unknown };
        if (typeof info.pid !== "number") return null;
        process.kill(info.pid, 0);
        return agent;
    } catch {
        return null;
    }
}

/** The socket a terminal attaches to, for an agent's session on the host. */
export function hostAttachSocket(agent: string, home: string = AIBALL_HOME): string {
    return join(home, "hosts", agent, "attach.sock");
}
