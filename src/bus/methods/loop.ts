/**
 * #3227 — the loops of this machine, for a client that drives them without
 * the claude-loop command (tvty): list them, stopped ones included, and
 * restart one where it ran or move it between the session host and tmux,
 * its conversation resumed. The work stays claude-loop's (`restart` from the
 * plate), run by the daemon as `session.start` runs `start`. A human's
 * gesture, on this machine only.
 */
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { defineMethod, Refusal, type Caller } from "../methods.js";
import { remoteControl } from "../params.js";
import { ERROR_CODES } from "../../domain.js";
import { listLoopPlates, plateAgent, type LoopEntry } from "../../pane.js";
import { MUX_CMD, tmuxName } from "../../claude-loop/state.js";
import { sessionFor, tmuxSessionView, viewOf } from "../../sessions/registry.js";
import { isPresent } from "../../live-presence.js";
import { getConsumer } from "../../db/consumers.js";
import { getAgentBar } from "../../agent-bar-store.js";
import { remoteControlFlags } from "../../claude-loop/remote-control.js";

const HUMAN_HERE = {
    who: ["human"] as const,
    relayed: false,
    denied: { message: "starting or moving a loop is a human's gesture", code: ERROR_CODES.MODERATOR_ONLY },
};

function localOnly(caller: Caller): void {
    if (caller.transport !== "uds") throw new Refusal(403, "a loop of this machine: local callers only", ERROR_CODES.FORBIDDEN);
}

/** A loop as a client shows it: where it runs, whether it does, and what to open. */
export interface LoopView {
    name: string;
    cwd: string | null;
    agent: string | null;
    project: string | null;
    role: string | null;
    mode: "host" | "tmux";
    running: boolean;
    /** Claude's Remote Control as the loop last started: off, or the session's name (`true`: Claude named it). */
    remote_control: boolean | string;
    /** The tmux session to attach, for a loop in tmux. */
    tmux?: string;
    /** The host's attach socket, for a loop on the host that runs. */
    attach?: { socket: string | null };
}

function tmuxAlive(name: string): boolean {
    return spawnSync(MUX_CMD, ["has-session", "-t", tmuxName(name)], { stdio: "ignore" }).status === 0;
}

function loopView(e: LoopEntry): LoopView {
    const agent = plateAgent(e.plate);
    const mode = e.plate.host_agent ? "host" : "tmux";
    const link = mode === "host" && agent ? sessionFor({ agent }) : undefined;
    const running = mode === "host" ? !!link?.running : tmuxAlive(e.name);
    return {
        name: e.name,
        cwd: e.plate.cwd ?? null,
        agent,
        project: e.plate.project ?? (agent ? getConsumer(agent)?.project ?? null : null),
        role: e.plate.role ?? null,
        mode,
        running,
        remote_control: e.plate.remote_control ?? false,
        ...(mode === "tmux" ? { tmux: tmuxName(e.name) } : {}),
        ...(link && running ? { attach: viewOf(link).attach } : {}),
    };
}

/** The loop a caller names: by its name, or the latest of an agent. */
function findLoop(p: { name?: string; agent?: string }): LoopEntry {
    const all = listLoopPlates();
    const found = p.name
        ? all.find((e) => e.name === p.name)
        : all.filter((e) => plateAgent(e.plate) === p.agent).sort((a, b) => b.at - a.at)[0];
    if (!found) throw new Refusal(404, `no loop ${p.name ?? `of ${p.agent}`} on this machine`, ERROR_CODES.NOT_FOUND);
    return found;
}

/**
 * The loops of this machine, stopped ones included, from their plates: each
 * one's folder, agent, project and role, where it runs (the session host or
 * tmux), whether it does, whether Claude has Remote Control (off, or the
 * session's name), and what to open (the tmux session, or the host's attach
 * socket).
 */
defineMethod({
    name: "loop.list",
    ...HUMAN_HERE,
    params: z.object({}),
    run: (caller) => {
        localOnly(caller);
        return listLoopPlates().sort((a, b) => b.at - a.at).map(loopView);
    },
});

/**
 * Restart a loop from its plate, its conversation resumed: where it ran, or
 * in `mode` (the session host or tmux) to move it. `fresh` starts a fresh
 * conversation instead. `remote_control` changes Claude's Remote Control (on,
 * off, or on under a name) for this start and the next; without it the loop
 * keeps its own. A loop that runs is stopped first, so it is refused
 * while Claude works (`NOT_IDLE`), unless `force`. Answers the loop's view
 * once it is back.
 */
defineMethod({
    name: "loop.restart",
    ...HUMAN_HERE,
    params: z.object({
        name: z.string().optional(),
        agent: z.string().optional(),
        mode: z.enum(["host", "tmux"]).optional(),
        fresh: z.boolean().optional(),
        force: z.boolean().optional(),
        remote_control: remoteControl.optional(),
    }),
    run: async (caller, p) => {
        localOnly(caller);
        if (!p.name === !p.agent) throw new Refusal(400, "name or agent: one of them", ERROR_CODES.BAD_REQUEST);
        const loop = findLoop(p);
        const before = loopView(loop);
        if (before.running && !p.force && before.agent) {
            const phase = getAgentBar(before.agent)?.bar.phase;
            if (phase !== "idle") {
                throw new Refusal(409, `Claude is ${phase ?? "in an unknown state"}: restarting now would cut its turn (wait until it is idle, or pass force)`, ERROR_CODES.NOT_IDLE);
            }
        }
        const mode = p.mode ?? before.mode;
        const child = spawn(CLAUDE_LOOP_BIN, [
            "restart", loop.name, p.fresh ? "--fresh" : "--resume", `--${mode}`,
            ...remoteControlFlags(p.remote_control),
        ], { cwd: loop.plate.cwd ?? undefined, detached: true, stdio: "ignore" });
        child.unref();
        // Back once a new plate is written (the restart removes the state dir
        // and starts again) and the loop runs where it was asked.
        const deadline = Date.now() + 60_000;
        for (;;) {
            await new Promise((r) => setTimeout(r, 250));
            const now = listLoopPlates().find((e) => e.name === loop.name);
            if (now && now.plate.created_at !== loop.plate.created_at) {
                const view = loopView(now);
                const up = view.mode === "host"
                    ? view.running
                    : view.running && !!view.agent && isPresent(view.agent) && !!tmuxSessionView(view.agent);
                if (view.mode === mode && up) return view;
            }
            if (child.exitCode !== null && child.exitCode !== 0) {
                throw new Refusal(500, `claude-loop restart exited ${child.exitCode}`, ERROR_CODES.INTERNAL);
            }
            if (Date.now() > deadline) throw new Refusal(504, `the loop ${loop.name} did not come back in 60 s`, ERROR_CODES.INTERNAL);
        }
    },
});

/** The loop's launcher, next to the daemon's source. */
const CLAUDE_LOOP_BIN = resolve(import.meta.dirname, "..", "..", "..", "bin", "claude-loop");
