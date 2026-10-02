/**
 * #3066 — sessions on the bus (docs/SESSION-HOST.md): start, stop, list. A
 * session runs a command on this machine: starting or stopping one is a
 * human's gesture, never through a proxy node.
 */
import { spawn } from "node:child_process";
import { isMachineLocal } from "../../machine-secret.js";
import { join, resolve } from "node:path";
import { z } from "zod";
import { defineMethod, Refusal } from "../methods.js";
import { remoteControl } from "../params.js";
import { defineSubject } from "../subscriptions.js";
import { ERROR_CODES } from "../../domain.js";
import { hostDirFor, SESSION_NAME } from "../../sessions/hosts.js";
import { sessionEnv } from "../../sessions/env.js";
import { listSessionViews, sessionFor, setSessionLabel, startSession, stopSession, viewOf } from "../../sessions/registry.js";
import { isPresent } from "../../live-presence.js";
import { listConsumers } from "../../db/consumers.js";
import { tmuxSessionView } from "../../sessions/registry.js";
import { remoteControlFlags } from "../../claude-loop/remote-control.js";

const HUMAN_HERE = {
    who: ["human"] as const,
    machine: true,
    denied: { message: "starting or stopping a session is a human's gesture", code: ERROR_CODES.MODERATOR_ONLY },
};

/**
 * #3235 — an agent's session that runs something: a host left without its
 * command (a loop stopped before its end shut the host down) is shut down and
 * forgotten here, so a new start replaces it instead of answering HOST_BUSY.
 */
async function busySession(agent: string): Promise<boolean> {
    const link = sessionFor({ agent });
    if (!link) return false;
    if (link.running) return true;
    await stopSession(link);
    return false;
}

const size = z.object({ rows: z.number().int().min(1).max(1000), cols: z.number().int().min(1).max(1000) }).optional();

/**
 * Start a session on this machine, in `cwd`. With `name`: a session without an
 * agent running `argv`. Without: an agent's loop, started as `claude-loop
 * start` would (`agent`, or `crew` with a crew agent's name, or neither and
 * the folder decides); the answer names the agent. The loop runs where `mode`
 * says — `host` (this daemon's session host) or `tmux` (a tmux session, the
 * loop's bar in its status line) — or, without it, where the loop's start
 * decides, as from a terminal: the project's `claude_loop.session` (host by
 * default), and tmux for a folder bound to a remote daemon. `remote_control` starts Claude
 * with Remote Control (`true`: the session named after the agent, a string: that
 * name, `false`: without it), over the project's `claude.remote_control`, and
 * the loop keeps it for its restarts. The login environment and a local
 * caller's allow-listed `env`. HOST_BUSY when it already runs.
 */
defineMethod({
    name: "session.start",
    ...HUMAN_HERE,
    params: z.object({
        agent: z.string().regex(SESSION_NAME).optional(),
        name: z.string().regex(SESSION_NAME).optional(),
        argv: z.array(z.string()).min(1).optional(),
        cwd: z.string().min(1),
        project: z.string().optional(),
        crew: z.string().regex(SESSION_NAME).optional(),
        size,
        env: z.record(z.string(), z.unknown()).optional(),
        /** #3135 — an agent's loop: on the session host or in tmux; the configured mode by default. */
        mode: z.enum(["host", "tmux"]).optional(),
        /** #3254 — Claude with Remote Control: on, off, or on under a name. */
        remote_control: remoteControl.optional(),
    }),
    run: async (caller, p) => {
        if (p.name && p.mode) throw new Refusal(400, "mode is an agent loop's: a named session runs on the host");
        if (p.name && p.remote_control !== undefined) throw new Refusal(400, "remote_control is an agent loop's: a named session runs no Claude");
        if (p.name && (p.agent || p.crew)) throw new Refusal(400, "name is a session without an agent: not with agent or crew");
        if (p.agent && p.crew) throw new Refusal(400, "agent or crew, not both");
        if (!p.name) {
            const named = p.agent ?? p.crew;
            if (named && isPresent(named)) {
                throw new Refusal(409, `${named} runs in claude-loop`, ERROR_CODES.HOST_BUSY, { host: "claude-loop" });
            }
            if (named && await busySession(named)) {
                throw new Refusal(409, `${named} runs on this daemon's host already`, ERROR_CODES.HOST_BUSY, { host: "daemon" });
            }
            // #3066 3c — the loop's own start prepares Claude (settings, hooks,
            // state) as for tmux, then asks back for the host (session.host)
            // and starts the kernel on it: one way to prepare Claude, not two.
            const env = sessionEnv(p.env, isMachineLocal(caller));
            const before = new Set(listSessionViews().map((v) => v.agent).filter(Boolean));
            const present = new Set(listConsumers().filter((c) => isPresent(c.consumer_id)).map((c) => c.consumer_id));
            const args = loopStartArgs(p);
            const child = spawn(process.execPath, [CLAUDE_LOOP_BIN, ...args], { cwd: p.cwd, env, detached: true, stdio: "ignore" });
            // Without a listener a failed spawn is an uncaught 'error' event:
            // it took the whole daemon down, as project.launch once did (#3103).
            let spawnError: string | null = null;
            child.on("error", (e) => { spawnError = e.message; });
            child.unref();
            const deadline = Date.now() + 30_000;
            for (;;) {
                // #3298 — without a mode, the loop decides where it runs (its
                // configured mode, tmux for a folder on a remote daemon): the
                // answer is where it came up, the host or tmux.
                if (p.mode !== "tmux") {
                    // The named agent's session; or, when the folder decides, the new one started here.
                    const view = named
                        ? listSessionViews().find((v) => v.agent === named)
                        : listSessionViews().find((v) => v.agent && !before.has(v.agent) && v.cwd === p.cwd);
                    if (view) return view;
                }
                if (p.mode !== "host") {
                    // In tmux, the loop is up once its kernel is present.
                    const agent = named
                        ? (isPresent(named) ? named : null)
                        : listConsumers().find((c) => c.cwd === p.cwd && isPresent(c.consumer_id) && !present.has(c.consumer_id))?.consumer_id ?? null;
                    const view = agent ? tmuxSessionView(agent) : null;
                    if (view) return view;
                }
                if (spawnError) throw new Refusal(500, `claude-loop start could not be launched: ${spawnError}`, ERROR_CODES.INTERNAL);
                if (child.exitCode !== null && child.exitCode !== 0) {
                    throw new Refusal(500, `claude-loop ${args.slice(0, 2).join(" ")} exited ${child.exitCode}`, ERROR_CODES.INTERNAL);
                }
                if (Date.now() > deadline) throw new Refusal(504, "the agent's session did not come up in 30 s", ERROR_CODES.INTERNAL);
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        if (sessionFor({ name: p.name! })) {
            throw new Refusal(409, `a session named ${p.name} runs already`, ERROR_CODES.HOST_BUSY, { host: "daemon" });
        }
        if (!p.argv) throw new Refusal(400, "argv: the command a session without an agent runs");
        // A local caller's variables, allow-listed, over the login environment.
        const env = sessionEnv(p.env, isMachineLocal(caller));
        try {
            const link = await startSession({ name: p.name, argv: p.argv, cwd: p.cwd, size: p.size, env });
            return viewOf(link);
        } catch (e) {
            throw new Refusal(500, (e as Error).message, ERROR_CODES.INTERNAL);
        }
    },
});

/**
 * #3298 — the `claude-loop start` a `session.start` runs. `--host` / `--tmux`
 * only when the caller chose: otherwise the loop's start decides, as it does
 * from a terminal — the folder's configured mode, and tmux for a folder bound
 * to a remote daemon (whose session host is not this one).
 */
export function loopStartArgs(p: { cwd: string; mode?: "host" | "tmux"; agent?: string; crew?: string; project?: string; remote_control?: boolean | string }): string[] {
    return [
        "start", ...(p.mode ? [`--${p.mode}`] : []), "--no-attach", "--cwd", p.cwd,
        ...(p.agent ? ["--agent", p.agent] : []),
        ...(p.crew ? ["--crew", p.crew] : []),
        ...(p.project ? ["--project", p.project] : []),
        ...remoteControlFlags(p.remote_control),
    ];
}

/** The loop's launcher, next to the daemon's source. A `#!/usr/bin/env node`
 *  script with no extension: Windows cannot execute it, so it is always run
 *  as `node <launcher>` (process.execPath), on every platform. */
const CLAUDE_LOOP_BIN = resolve(import.meta.dirname, "..", "..", "..", "bin", "claude-loop");

/**
 * #3066 3c — `claude-loop start --host` asks for its host here: the command
 * it prepared (Claude, its settings and hooks), run in an agent's session on
 * this daemon's host. The command's environment gets `CL_HOST_CONTROL`, so
 * Claude's hooks drive the host; the answer gives it to the kernel the loop
 * starts next. Local callers only: the command runs on this machine.
 */
defineMethod({
    name: "session.host",
    who: ["human", "agent"],
    machine: true,
    params: z.object({
        agent: z.string().regex(SESSION_NAME),
        argv: z.array(z.string()).min(1),
        cwd: z.string().min(1),
        size,
        env: z.record(z.string(), z.unknown()).optional(),
    }),
    run: async (caller, p) => {
        if (!isMachineLocal(caller)) throw new Refusal(403, "a session runs on this machine: local callers only", ERROR_CODES.FORBIDDEN);
        if (await busySession(p.agent)) {
            throw new Refusal(409, `${p.agent} runs on this daemon's host already`, ERROR_CODES.HOST_BUSY, { host: "daemon" });
        }
        const control = join(hostDirFor({ agent: p.agent }), "control.sock");
        const env = { ...sessionEnv(p.env, true), CL_HOST_CONTROL: control };
        try {
            const link = await startSession({ agent: p.agent, argv: p.argv, cwd: p.cwd, size: p.size, env });
            return { ...viewOf(link), control };
        } catch (e) {
            throw new Refusal(500, (e as Error).message, ERROR_CODES.INTERNAL);
        }
    },
});

/**
 * Stop a session: its command, then its host, whose files go with it. Answers
 * `{ stopping: true }` at once (#3158): the end comes as the session's state
 * (`session.<name>.state` / `agent.<id>.state`, the session gone), so a slow
 * program does not hold the caller's connection. With `wait`, answers once
 * the host is gone, with the command's `exit_code` (`claude-loop rm`, which
 * starts the loop again right after).
 */
defineMethod({
    name: "session.stop",
    // A human's gesture; and an agent's own loop stops its own session (`claude-loop rm`), locally.
    who: ["human", "agent"],
    machine: true,
    params: z.object({ agent: z.string().optional(), name: z.string().optional(), wait: z.boolean().optional() }),
    run: async (caller, p) => {
        if (!p.agent === !p.name) throw new Refusal(400, "one of agent or name");
        if (caller.kind !== "human" && (!isMachineLocal(caller) || p.agent !== caller.consumer_id)) {
            throw new Refusal(403, "stopping a session is a human's gesture, or an agent's own loop on this machine", ERROR_CODES.MODERATOR_ONLY);
        }
        const link = sessionFor(p);
        if (!link) throw new Refusal(404, "no such session on this daemon", ERROR_CODES.NOT_FOUND);
        if (!p.wait) {
            void stopSession(link).catch(() => { /* the session's state says how it ended */ });
            return { agent: p.agent ?? null, name: p.name ?? null, stopping: true };
        }
        const exit_code = await stopSession(link);
        return { agent: p.agent ?? null, name: p.name ?? null, exit_code };
    },
});

/**
 * #3481 — a label for a session without an agent (a terminal opened from tvty),
 * shown by every client in place of its name; `null` takes it away. The name
 * stays the key: the host's dir, its socket, `session.stop`.
 */
defineMethod({
    name: "session.label",
    ...HUMAN_HERE,
    params: z.object({ name: z.string(), label: z.string().max(200).nullable() }),
    run: (_caller, p) => {
        const link = sessionFor({ name: p.name });
        if (!link) {
            if (sessionFor({ agent: p.name })) throw new Refusal(409, "an agent's session is named by its agent: it takes no label", ERROR_CODES.CONFLICT);
            throw new Refusal(404, "no such session on this daemon", ERROR_CODES.NOT_FOUND);
        }
        if (p.label !== null && p.label.trim() === "") throw new Refusal(400, "a label is not empty: null takes it away");
        return setSessionLabel(link, p.label);
    },
});

/** Every session this daemon hosts: agent or name, cwd, running, clients, and the socket clients attach to. */
defineMethod({
    name: "session.list",
    machine: true,
    who: ["human", "agent"],
    params: z.object({}),
    run: () => listSessionViews(),
});

/** `session.<name>.state`: a session without an agent; `*` for all, those started later too. */
defineSubject({
    pattern: "session.*.state",
    // #3294 — this machine's sessions: a proxy node serves it for its own.
    machine: true,
    doc: { value: "a session without an agent, as session.list gives it, or null; with *, keyed by name", event: "{ name, session }: started, clients, exited; session null once stopped" },
    wildcard: true,
    access: (caller) => (caller.kind === "key" ? new Refusal(403, "a consumer's subject") : null),
    value: (sub) => {
        const views = listSessionViews().filter((v) => v.name !== null);
        if (sub.parts[1] !== "*") return views.find((v) => v.name === sub.parts[1]) ?? null;
        return Object.fromEntries(views.map((v) => [v.name!, v]));
    },
});
