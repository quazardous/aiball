/**
 * #3468 — the agents' sessions a proxy node's own host holds, as the node says
 * them (`node_sessions_push` on its connection, src/proxy-ws.ts). The hub's
 * registry only knows its own hosts: without this, an agent whose loop runs on
 * a node's host read `session: null` in its entry (`agent.<id>.state`), while
 * the node's `session.list` showed it.
 *
 * A node token is the weak point (docs/SECURITY.md): what a node says is kept
 * only as far as it can be checked here.
 * - The machine is the node's, whatever the frame said.
 * - A session counts only for an agent whose loop is live through that same
 *   node (its presence's machine): a node cannot put a session on an agent
 *   that runs elsewhere. Checked when read, so a loop that connects after its
 *   node's push is seen as soon as it is.
 * - A node token restricted to projects (`tokens.projects`) speaks only for
 *   agents of those projects.
 * Forgotten when the node's connection closes.
 */
import type { SessionView } from "./registry.js";

interface NodeEntry {
    /** `node:<label>`, the machine the node's sessions are on. */
    machine: string;
    /** The projects its token is restricted to; null when it is not. */
    projects: string[] | null;
    sessions: Map<string, SessionView>;
}

const byNode = new Map<string, NodeEntry>();

/** What a node's frame says of one session, kept when it has the shape of one; null otherwise. */
export function sessionOfFrame(raw: unknown, machine: string): SessionView | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const socket = (o.attach as { socket?: unknown } | undefined)?.socket;
    if (typeof o.agent !== "string" || !o.agent || typeof socket !== "string" || !socket) return null;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    return {
        agent: o.agent,
        name: null,
        host: "daemon",
        machine,
        pid: num(o.pid, 0),
        cwd: typeof o.cwd === "string" ? o.cwd : "",
        running: o.running === true,
        clients: num(o.clients, 0),
        interactive: typeof o.interactive === "number" ? o.interactive : null,
        attach: { socket },
    };
}

/** The projects a token is restricted to, from its JSON column; null when it is not. */
export function tokenProjects(json: string | null | undefined): string[] | null {
    if (!json) return null;
    try {
        const v = JSON.parse(json) as unknown;
        return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : null;
    } catch {
        return null;
    }
}

/**
 * A node's sessions, all of them at once (what it holds now). Returns the
 * agents whose entry may have changed: those it said before or says now.
 */
export function setNodeSessions(nodeId: string, label: string | null, projects: string[] | null, raw: unknown[], projectOf: (agent: string) => string | null): { changed: string[]; refused: string[] } {
    const machine = `node:${label ?? "?"}`;
    const before = byNode.get(nodeId)?.sessions ?? new Map<string, SessionView>();
    const sessions = new Map<string, SessionView>();
    const refused: string[] = [];
    for (const r of raw) {
        const s = sessionOfFrame(r, machine);
        if (!s) continue;
        if (projects && !projects.includes(projectOf(s.agent!) ?? "")) {
            refused.push(s.agent!);
            continue;
        }
        sessions.set(s.agent!, s);
    }
    byNode.set(nodeId, { machine, projects, sessions });
    const changed = new Set<string>();
    for (const [a, s] of sessions) if (JSON.stringify(before.get(a)) !== JSON.stringify(s)) changed.add(a);
    for (const a of before.keys()) if (!sessions.has(a)) changed.add(a);
    return { changed: [...changed], refused };
}

/** The node's connection closed: its sessions are gone. Returns the agents it had one for. */
export function clearNodeSessions(nodeId: string): string[] {
    const e = byNode.get(nodeId);
    byNode.delete(nodeId);
    return e ? [...e.sessions.keys()] : [];
}

/**
 * The session a node holds for `agent`, when the agent's loop is live through
 * that node (`machine`, its presence's machine); null otherwise.
 */
export function nodeSessionFor(agent: string, presenceMachine: string | null): SessionView | null {
    if (!presenceMachine) return null;
    for (const e of byNode.values()) {
        if (e.machine !== presenceMachine) continue;
        const s = e.sessions.get(agent);
        if (s) return s;
    }
    return null;
}

/** Tests only. */
export function forgetNodeSessionsForTests(): void {
    byNode.clear();
}
