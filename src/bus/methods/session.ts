/**
 * #3066 — sessions on the bus (docs/SESSION-HOST.md): start, stop, list. A
 * session runs a command on this machine: starting or stopping one is a
 * human's gesture, never through a proxy node.
 */
import { z } from "zod";
import { defineMethod, Refusal } from "../methods.js";
import { defineSubject } from "../subscriptions.js";
import { ERROR_CODES } from "../../domain.js";
import { SESSION_NAME } from "../../sessions/hosts.js";
import { allowedEnv, loginEnv } from "../../sessions/env.js";
import { listSessionViews, sessionFor, startSession, stopSession, viewOf } from "../../sessions/registry.js";
import { isPresent } from "../../live-presence.js";

const HUMAN_HERE = {
    who: ["human"] as const,
    relayed: false,
    denied: { message: "starting or stopping a session is a human's gesture", code: ERROR_CODES.MODERATOR_ONLY },
};

const size = z.object({ rows: z.number().int().min(1).max(1000), cols: z.number().int().min(1).max(1000) }).optional();

/** Start a session on this machine: an agent's (with the loop kernel, to come) or a named one running `argv`, in `cwd`, at `size`, with the login environment and a local caller's allow-listed `env`. HOST_BUSY when it already runs. */
defineMethod({
    name: "session.start",
    ...HUMAN_HERE,
    params: z.object({
        agent: z.string().regex(SESSION_NAME).optional(),
        name: z.string().regex(SESSION_NAME).optional(),
        argv: z.array(z.string()).min(1).optional(),
        cwd: z.string().min(1),
        project: z.string().optional(),
        crew: z.boolean().optional(),
        size,
        env: z.record(z.string(), z.unknown()).optional(),
    }),
    run: async (caller, p) => {
        if (!p.agent === !p.name) throw new Refusal(400, "one of agent or name");
        if (p.agent) {
            if (isPresent(p.agent)) {
                throw new Refusal(409, `${p.agent} runs in claude-loop`, ERROR_CODES.HOST_BUSY, { host: "claude-loop" });
            }
            // The loop kernel that drives an agent's Claude comes with the next phase.
            throw new Refusal(501, "an agent's session on a host comes with the loop kernel in the daemon", ERROR_CODES.NOT_IMPLEMENTED);
        }
        if (sessionFor({ name: p.name })) {
            throw new Refusal(409, `a session named ${p.name} runs already`, ERROR_CODES.HOST_BUSY, { host: "daemon" });
        }
        if (!p.argv) throw new Refusal(400, "argv: the command a session without an agent runs");
        // A local caller's variables, allow-listed, over the login environment.
        const env = { ...loginEnv(), ...(caller.transport === "uds" ? allowedEnv(p.env) : {}) };
        try {
            const link = await startSession({ name: p.name, argv: p.argv, cwd: p.cwd, size: p.size, env });
            return viewOf(link);
        } catch (e) {
            throw new Refusal(500, (e as Error).message, ERROR_CODES.INTERNAL);
        }
    },
});

/** Stop a session: its command, then its host, whose files go with it. Answers once the host is gone. */
defineMethod({
    name: "session.stop",
    ...HUMAN_HERE,
    params: z.object({ agent: z.string().optional(), name: z.string().optional() }),
    run: async (_c, p) => {
        if (!p.agent === !p.name) throw new Refusal(400, "one of agent or name");
        const link = sessionFor(p);
        if (!link) throw new Refusal(404, "no such session on this daemon", ERROR_CODES.NOT_FOUND);
        const exit_code = await stopSession(link);
        return { agent: p.agent ?? null, name: p.name ?? null, exit_code };
    },
});

/** Every session this daemon hosts: agent or name, cwd, running, clients, and the socket clients attach to. */
defineMethod({
    name: "session.list",
    who: ["human", "agent"],
    params: z.object({}),
    run: () => listSessionViews(),
});

/** `session.<name>.state`: a session without an agent; `*` for all, those started later too. */
defineSubject({
    pattern: "session.*.state",
    doc: { value: "a session without an agent, as session.list gives it, or null; with *, keyed by name", event: "{ name, session }: started, clients, exited; session null once stopped" },
    wildcard: true,
    access: (caller) => (caller.kind === "key" ? new Refusal(403, "a consumer's subject") : null),
    value: (sub) => {
        const views = listSessionViews().filter((v) => v.name !== null);
        if (sub.parts[1] !== "*") return views.find((v) => v.name === sub.parts[1]) ?? null;
        return Object.fromEntries(views.map((v) => [v.name!, v]));
    },
});
