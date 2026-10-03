/**
 * #3227 — the loops of this machine, for a client that drives them without
 * the claude-loop command (tvty): list them, stopped ones included, and
 * restart one where it ran or move it between the session host and tmux,
 * its conversation resumed. The work stays claude-loop's (`restart` from the
 * plate), run by the daemon as `session.start` runs `start`. A human's
 * gesture, on this machine only.
 */
import { spawn, spawnSync } from "node:child_process";
import { isMachineLocal } from "../../machine-secret.js";
import { join, resolve } from "node:path";
import { statSync, watch, type FSWatcher } from "node:fs";
import { z } from "zod";
import { defineMethod, Refusal, type Caller } from "../methods.js";
import { defineSubject, publish } from "../subscriptions.js";
import { onBroadcast } from "../../ws.js";
import { remoteControl } from "../params.js";
import { ERROR_CODES } from "../../domain.js";
import { listLoopPlates, plateAgent, type LoopEntry } from "../../pane.js";
import { loopStateRoot, MUX_CMD, tmuxAlive, tmuxClientList, tmuxClients, tmuxName } from "../../claude-loop/state.js";
import { tmuxSessions } from "../../claude-loop/mux-async.js";
import { sessionFor, tmuxSessionView, viewOf } from "../../sessions/registry.js";
import { tmuxClientsOf } from "../../sessions/tmux-clients.js";
import { isPresent } from "../../live-presence.js";
import { getConsumer } from "../../db/consumers.js";
import { getAgentBar } from "../../agent-bar-store.js";
import { remoteControlFlags } from "../../claude-loop/remote-control.js";

const HUMAN_HERE = {
    who: ["human"] as const,
    machine: true,
    denied: { message: "starting or moving a loop is a human's gesture", code: ERROR_CODES.MODERATOR_ONLY },
};

function localOnly(caller: Caller): void {
    if (!isMachineLocal(caller)) throw new Refusal(403, "a loop of this machine: local callers only", ERROR_CODES.FORBIDDEN);
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
    /** #3283 — the model its Claude ran its last turn on, as its bar says; null when unknown. */
    model: { id: string; name: string } | null;
    /** The tmux session to attach, for a loop in tmux. */
    tmux?: string;
    /** The host's attach socket, for a loop on the host that runs. */
    attach?: { socket: string | null };
    /** #3338 — when the loop last started (its plate's `created_at`: a restart writes it again). */
    started_at: string | null;
    /** #3338 — the loop's last sign of life: when its log was last written. */
    last_seen_at: string | null;
    /** #3338 — a stopped loop whose agent has a loop that runs, or a later one: the others show that one. */
    superseded: boolean;
    /**
     * #3340 — clients attached to a loop that runs, and how many have the
     * controls: the host's word, or in tmux the loop's; null when stopped or
     * not said yet. A client attached counts itself.
     */
    clients: number | null;
    interactive: number | null;
}

function lastSeenAt(name: string): string | null {
    try { return statSync(join(loopStateRoot(), name, "loop.log")).mtime.toISOString(); } catch { return null; }
}

/**
 * #3338 — an agent's stopped loop is superseded by one of its loops that runs,
 * or by a later one (its start, else its plate). Loops with no agent are
 * never superseded: nothing ties them together.
 */
export function markSuperseded(loops: Array<Omit<LoopView, "superseded"> & { at: number }>): LoopView[] {
    const when = (l: { started_at: string | null; at: number }) => (l.started_at ? Date.parse(l.started_at) : NaN) || l.at;
    return loops.map((l, i) => {
        const superseded = !l.running && !!l.agent
            && loops.some((o, j) => j !== i && o.agent === l.agent && (o.running || when(o) > when(l)));
        return { ...withoutAt(l), superseded };
    });
}

/**
 * #3461 — the tmux sessions of this machine, read just now from one `ls` that
 * does not hold the daemon: a `has-session` per loop, synchronous, froze it
 * ~100 ms a loop on Windows, every 30 s and on every change. Never kept: a
 * view built from an older answer would miss a session started since. Null
 * when tmux cannot say: the views then ask per loop, as before.
 */
type LiveTmux = Set<string> | null;

function loopView(e: LoopEntry, live: LiveTmux = null): Omit<LoopView, "superseded"> & { at: number } {
    const agent = plateAgent(e.plate);
    const mode = e.plate.host_agent ? "host" : "tmux";
    const link = mode === "host" && agent ? sessionFor({ agent }) : undefined;
    const running = mode === "host" ? !!link?.running : live ? live.has(tmuxName(e.name)) : tmuxAlive(e.name);
    return {
        name: e.name,
        cwd: e.plate.cwd ?? null,
        agent,
        project: e.plate.project ?? (agent ? getConsumer(agent)?.project ?? null : null),
        role: e.plate.role ?? null,
        mode,
        running,
        remote_control: e.plate.remote_control ?? false,
        model: running && agent ? getAgentBar(agent)?.bar.model ?? null : null,
        ...(mode === "tmux" ? { tmux: tmuxName(e.name) } : {}),
        ...(link && running ? { attach: viewOf(link).attach } : {}),
        clients: !running ? null : link ? link.clients : agent ? tmuxClientsOf(agent)?.clients ?? null : null,
        interactive: !running ? null : link ? link.interactive : agent ? tmuxClientsOf(agent)?.interactive ?? null : null,
        started_at: e.plate.created_at ?? null,
        last_seen_at: lastSeenAt(e.name),
        at: e.at,
    };
}

/** Every loop of this machine as a client shows it, the latest first. */
function loopViews(live: LiveTmux = null): LoopView[] {
    return markSuperseded(listLoopPlates().sort((a, b) => b.at - a.at).map((e) => loopView(e, live)));
}

/** #3461 — every loop's view, its tmux sessions read once without holding the daemon. */
async function loopViewsNow(): Promise<LoopView[]> {
    return loopViews(await tmuxSessions());
}

/** #3417 — the agents whose loop runs on this machine: what an all-loops control reaches with `scope: "machine"` on a node. */
export function runningLoopAgents(): string[] {
    return [...new Set(loopViews().filter((l) => l.running && l.agent).map((l) => l.agent!))].sort();
}

/** #3489 — the conversations the running loops of this machine are on: its id → the loop's agent. */
export async function runningConversations(): Promise<Map<string, string>> {
    const live = await tmuxSessions();
    const out = new Map<string, string>();
    for (const e of listLoopPlates()) {
        const id = e.plate.session_id;
        if (!id) continue;
        const v = loopView(e, live);
        if (v.running && v.agent) out.set(id, v.agent);
    }
    return out;
}

function withoutAt<T extends { at: number }>(v: T): Omit<T, "at"> {
    const { at: _at, ...rest } = v;
    return rest;
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
 * session's name), what to open (the tmux session, or the host's attach
 * socket), when it last started and was last seen, and whether another loop
 * of its agent supersedes it.
 */
defineMethod({
    name: "loop.list",
    ...HUMAN_HERE,
    params: z.object({}),
    run: async (caller) => {
        localOnly(caller);
        return loopViewsNow();
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
        const child = spawn(process.execPath, [CLAUDE_LOOP_BIN,
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
                const live = await tmuxSessions();
                const view = loopView(now, live);
                const up = view.mode === "host"
                    ? view.running
                    : view.running && !!view.agent && isPresent(view.agent) && !!tmuxSessionView(view.agent);
                if (view.mode === mode && up) return loopViews(live).find((v) => v.name === now.name) ?? { ...withoutAt(view), superseded: false };
            }
            if (child.exitCode !== null && child.exitCode !== 0) {
                throw new Refusal(500, `claude-loop restart exited ${child.exitCode}`, ERROR_CODES.INTERNAL);
            }
            if (Date.now() > deadline) throw new Refusal(504, `the loop ${loop.name} did not come back in 60 s`, ERROR_CODES.INTERNAL);
        }
    },
});

/**
 * #3343 — the clients of a loop in tmux, other than `keep_pid`'s (the one
 * taking the controls): made read-only copies (`clients_readonly`, the
 * COPY_MARK shows on them), or detached (`clients_detach`). tmux does it; a
 * client (tvty) asks aiball. A loop on the host has its own controls.
 */
function otherTmuxClients(caller: Caller, p: { name?: string; agent?: string; keep_pid?: number }) {
    localOnly(caller);
    if (!p.name === !p.agent) throw new Refusal(400, "name or agent: one of them", ERROR_CODES.BAD_REQUEST);
    const loop = findLoop(p);
    const view = loopView(loop);
    if (view.mode !== "tmux") throw new Refusal(409, `${loop.name} runs on the session host: its clients take the controls there`, ERROR_CODES.CONFLICT);
    if (!view.running) throw new Refusal(404, `the loop ${loop.name} does not run`, ERROR_CODES.LOOP_NOT_FOUND);
    const all = tmuxClientList(loop.name);
    // #3477 — psmux cannot tell its clients apart: refused, not answered as done.
    if (all === null) throw new Refusal(501, "psmux cannot tell its clients apart (list-clients ignores -F): no client was changed", ERROR_CODES.NOT_IMPLEMENTED);
    return { loop, others: all.filter((c) => c.pid !== p.keep_pid) };
}

const clientsParams = z.object({ name: z.string().optional(), agent: z.string().optional(), keep_pid: z.number().int().optional() });

/** Every other client of a loop in tmux becomes a read-only copy (all but `keep_pid`'s); answers the clients left. */
defineMethod({
    name: "loop.clients_readonly",
    ...HUMAN_HERE,
    params: clientsParams,
    run: (caller, p) => {
        const { loop, others } = otherTmuxClients(caller, p);
        // `switch-client -r` toggles: only the clients that may still type.
        // `-t` the loop's own session: without it tmux also moves the client to
        // the session it last used, which takes it out of the loop.
        for (const c of others.filter((o) => !o.readonly)) spawnSync(MUX_CMD, ["switch-client", "-c", c.client, "-t", tmuxName(loop.name), "-r"], { stdio: "ignore" });
        return { name: loop.name, ...(tmuxClients(loop.name) ?? { clients: 0, interactive: 0 }) };
    },
});

/** Every other client of a loop in tmux is detached (all but `keep_pid`'s); answers the clients left. */
defineMethod({
    name: "loop.clients_detach",
    ...HUMAN_HERE,
    params: clientsParams,
    run: (caller, p) => {
        const { loop, others } = otherTmuxClients(caller, p);
        for (const c of others) spawnSync(MUX_CMD, ["detach-client", "-t", c.client], { stdio: "ignore" });
        return { name: loop.name, ...(tmuxClients(loop.name) ?? { clients: 0, interactive: 0 }) };
    },
});

/**
 * Wake a loop now, as `claude-loop wake` does: the loop tries a wake at its
 * next heartbeat (within its interval), without waiting for its drain tempo,
 * for the events waiting for it. The human's way out of a loop that stays
 * asleep with work waiting. A loop that does not run is `LOOP_NOT_FOUND`; one
 * whose Claude works is refused (`NOT_IDLE`), unless `force`.
 */
defineMethod({
    name: "loop.wake",
    ...HUMAN_HERE,
    params: z.object({
        name: z.string().optional(),
        agent: z.string().optional(),
        force: z.boolean().optional(),
    }),
    run: async (caller, p) => {
        localOnly(caller);
        if (!p.name === !p.agent) throw new Refusal(400, "name or agent: one of them", ERROR_CODES.BAD_REQUEST);
        const loop = findLoop(p);
        const view = loopView(loop);
        if (!view.running) throw new Refusal(404, `the loop ${loop.name} does not run`, ERROR_CODES.LOOP_NOT_FOUND);
        if (!p.force && view.agent) {
            const phase = getAgentBar(view.agent)?.bar.phase;
            if (phase !== "idle") {
                throw new Refusal(409, `Claude is ${phase ?? "in an unknown state"}: it will take its events when it is idle (or pass force)`, ERROR_CODES.NOT_IDLE);
            }
        }
        // Not spawnSync: the CLI starts in a second or two, which must not hold the daemon.
        const failure = await new Promise<string | null>((resolve) => {
            const child = spawn(process.execPath, [CLAUDE_LOOP_BIN, "wake", loop.name], { stdio: "ignore", timeout: 10_000 });
            child.on("error", (e) => resolve(e.message));
            child.on("exit", (code, signal) => resolve(code === 0 ? null : `exit ${code ?? signal}`));
        });
        if (failure) throw new Refusal(500, `claude-loop wake failed: ${failure}`, ERROR_CODES.INTERNAL);
        return { name: loop.name, requested: true };
    },
});

/** The loop's launcher, next to the daemon's source. */
const CLAUDE_LOOP_BIN = resolve(import.meta.dirname, "..", "..", "..", "bin", "claude-loop");

// ---- loop.<name>.state ------------------------------------------------------------

/**
 * #3357 — each loop of this machine as `loop.list` shows it, pushed when it
 * changed, `null` once it is forgotten (`rm`). A client (tvty) re-read
 * `loop.list` every 3 s for want of it. Recomputed, while anyone is
 * subscribed, when a plate is written or removed (the state root watched), on
 * the board's events that move a loop (a loop's presence, its tmux clients,
 * its bar's model, its host), and every 30 s for a tmux session killed with no
 * word said.
 */
const LOOP_DEBOUNCE_MS = 300;
const LOOP_SAFETY_MS = 30_000;
const loopState: {
    subs: number;
    sent: Map<string, string>;
    watcher: FSWatcher | null;
    safety: NodeJS.Timeout | null;
    debounce: NodeJS.Timeout | null;
    offBroadcast: (() => void) | null;
} = { subs: 0, sent: new Map(), watcher: null, safety: null, debounce: null, offBroadcast: null };

/** Views again; publish those that changed, `null` for those gone. */
async function publishLoopChanges(): Promise<void> {
    const now = new Map((await loopViewsNow()).map((v) => [v.name, v]));
    for (const [name, v] of now) {
        const json = JSON.stringify(v);
        if (loopState.sent.get(name) === json) continue;
        loopState.sent.set(name, json);
        publish(`loop.${name}.state`, v);
    }
    for (const name of [...loopState.sent.keys()]) {
        if (now.has(name)) continue;
        loopState.sent.delete(name);
        publish(`loop.${name}.state`, null);
    }
}

function scheduleLoopChanges(): void {
    if (loopState.subs === 0 || loopState.debounce) return;
    loopState.debounce = setTimeout(() => { loopState.debounce = null; void publishLoopChanges().catch(() => { /* the safety tick tries again */ }); }, LOOP_DEBOUNCE_MS);
    loopState.debounce.unref?.();
}

function startLoopWatch(): void {
    for (const v of loopViews()) loopState.sent.set(v.name, JSON.stringify(v));
    try {
        // A plate, or a loop's folder coming or going; its log writes are not a change.
        loopState.watcher = watch(loopStateRoot(), { recursive: true }, (_e, file) => {
            const f = String(file ?? "");
            if (f && !f.includes("/") && !f.includes("\\") || f.endsWith("plate.json")) scheduleLoopChanges();
        });
        loopState.watcher.on("error", () => { /* the safety tick covers it */ });
    } catch { /* no state root yet: the safety tick covers it */ }
    loopState.offBroadcast = onBroadcast((ev) => {
        if (ev.type === "consumer_changed" || ev.type === "agent_bar") scheduleLoopChanges();
    });
    loopState.safety = setInterval(() => { void publishLoopChanges().catch(() => { /* the next tick tries again */ }); }, LOOP_SAFETY_MS);
    loopState.safety.unref?.();
}

function stopLoopWatch(): void {
    loopState.watcher?.close();
    loopState.offBroadcast?.();
    if (loopState.safety) clearInterval(loopState.safety);
    if (loopState.debounce) clearTimeout(loopState.debounce);
    Object.assign(loopState, { watcher: null, offBroadcast: null, safety: null, debounce: null });
    loopState.sent.clear();
}

defineSubject({
    pattern: "loop.*.state",
    doc: {
        value: "the loop as loop.list shows it, or null; with *, keyed by loop name",
        event: "the whole view again whenever it changed; null once the loop is forgotten (rm)",
    },
    wildcard: true,
    machine: true,
    access: (caller) => caller.kind !== "human" ? new Refusal(403, "the loops of this machine are a human's view")
        : !isMachineLocal(caller) ? new Refusal(403, "a loop of this machine: local callers only", ERROR_CODES.FORBIDDEN)
        : null,
    setup: (sub) => {
        if (sub.state.watching) return;
        if (loopState.subs++ === 0) startLoopWatch();
        sub.state.watching = true;
    },
    value: (sub) => {
        const name = sub.parts[1]!;
        const views = loopViews();
        return name === "*" ? Object.fromEntries(views.map((v) => [v.name, v])) : views.find((v) => v.name === name) ?? null;
    },
    release: (sub) => {
        if (sub.state.watching && --loopState.subs === 0) stopLoopWatch();
    },
});

/** Tests only: compute and publish the changes now. */
export function publishLoopChangesForTests(): Promise<void> {
    return publishLoopChanges();
}
