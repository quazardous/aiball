/**
 * #3066 — the sessions this daemon hosts, by agent or by name: one host each
 * (docs/SESSION-HOST.md). Found again at boot, published as they change: an
 * agent's on `agent.<id>.state` (through `consumer_changed`), a named one's on
 * `session.<name>.state`.
 */
import { discoverHosts, startHost, type HostLink, type StartHost } from "./hosts.js";
import { broadcast } from "../ws.js";
import { publish } from "../bus/subscriptions.js";
import { getConsumer } from "../db/consumers.js";
import { isPresent } from "../live-presence.js";
import { resolveLoopName } from "../pane.js";
import { tmuxName } from "../claude-loop/state.js";
import { tmuxClientsOf } from "./tmux-clients.js";
import { thisMachine } from "../machine-name.js";

const byKey = new Map<string, HostLink>();

const keyOf = (s: { agent?: string | null; name?: string | null }) => (s.agent ? `agent:${s.agent}` : `name:${s.name}`);

export interface SessionView {
    agent: string | null;
    name: string | null;
    host: "daemon";
    /** #3412 — the machine that holds the session (`hub`, `node:<label>`): attachable from that machine only. */
    machine: string;
    pid: number;
    cwd: string;
    running: boolean;
    /** Clients attached, and (#3340) how many of them have the controls; null before the host says. */
    clients: number;
    interactive: number | null;
    attach: { socket: string };
}

/**
 * #3135 — an agent's loop running in tmux, on this machine: what a client needs
 * to tell it from a host session and reach it (`claude-loop attach`, or tmux
 * itself). Null when no local loop answers for it.
 */
export interface TmuxSessionView {
    agent: string;
    name: null;
    host: "tmux";
    /** #3412 — the machine the tmux session is on: reachable from that machine only. */
    machine: string;
    cwd: string;
    running: true;
    /** The tmux session the loop runs in. */
    tmux: string;
    /**
     * #3340 — clients attached to the tmux session, and how many have the
     * controls, as the loop last said (null before it did). A client attached
     * in tmux counts itself: another holds the loop when `clients` > 1 once
     * attached, or > 0 before.
     */
    clients: number | null;
    interactive: number | null;
}

export function tmuxSessionView(agent: string): TmuxSessionView | null {
    if (!isPresent(agent) || byKey.has(keyOf({ agent }))) return null; // not running, or on the host: its own view
    const c = getConsumer(agent);
    if (!c?.cwd || c.last_seen_via === "node") return null;
    const loop = resolveLoopName(c.cwd, agent);
    const said = tmuxClientsOf(agent);
    return loop
        ? { agent, name: null, host: "tmux", machine: thisMachine(), cwd: c.cwd, running: true, tmux: tmuxName(loop), clients: said?.clients ?? null, interactive: said?.interactive ?? null }
        : null;
}

export function viewOf(link: HostLink): SessionView {
    return {
        agent: link.info.agent,
        name: link.info.agent ? null : link.info.name,
        host: "daemon",
        machine: thisMachine(),
        pid: link.info.pid,
        cwd: link.info.cwd,
        running: link.running,
        clients: link.clients,
        interactive: link.interactive,
        attach: { socket: link.attachSocket() },
    };
}

function announce(link: HostLink, gone = false): void {
    const view = gone ? null : viewOf(link);
    if (link.info.agent) {
        broadcast({ type: "consumer_changed", data: { consumer_id: link.info.agent, session: view } });
    } else {
        publish(`session.${link.info.name}.state`, { name: link.info.name, session: view });
    }
}

function track(link: HostLink): void {
    const key = keyOf(link.info);
    byKey.set(key, link);
    link.on("host.clients", () => announce(link));
    link.on("host.exited", () => announce(link));
    link.on("gone", () => {
        if (byKey.get(key) === link) byKey.delete(key);
        announce(link, true);
    });
    announce(link);
}

/** At boot: take back the hosts still running. */
export async function initSessions(): Promise<number> {
    const links = await discoverHosts();
    for (const l of links) track(l);
    return links.length;
}

export function sessionFor(s: { agent?: string; name?: string }): HostLink | undefined {
    return byKey.get(keyOf(s));
}

export function listSessionViews(): SessionView[] {
    return [...byKey.values()].map(viewOf);
}

export async function startSession(o: StartHost): Promise<HostLink> {
    const link = await startHost(o);
    track(link);
    return link;
}

/** Stop the command and the host; resolves once the host is gone, its files with it. */
export async function stopSession(link: HostLink): Promise<number | null> {
    const gone = new Promise<void>((resolveGone) => link.once("gone", () => resolveGone()));
    let exit: number | null = null;
    link.once("host.exited", (p: { code: number }) => { exit = p.code; });
    await link.call("host.shutdown").catch(() => { /* it may close before answering */ });
    await Promise.race([gone, new Promise((r) => setTimeout(r, 15_000))]);
    return exit;
}

/** Tests only: forget every session (their hosts are the test's to stop). */
export function forgetSessionsForTests(): void {
    for (const l of byKey.values()) l.close();
    byKey.clear();
}
