/**
 * A board simulator scenario: gestures by simulated agents and the moderator,
 * with views and expectations in between (tests/sim/scenarios/*.yaml).
 *
 * Pure: parsing, `$name` substitution and matching an expectation against an
 * agent's seat live here, where a unit test reaches them; the runner
 * (tests/sim/sim.ts) only performs the gestures and fetches the seats.
 *
 *     name: a sole participant keeps its ticket after a handback
 *     steps:
 *       - alpha-lead: ticket_new             # an agent calls an MCP tool
 *         args: { title: "…" }
 *         save: { ticket: id }               # $ticket = the result's `id`
 *       - moderator: approve $ticket          # approve | reject | accept | refuse | comment
 *       - alpha-lead: ticket_reply
 *         args: { target_id: $ticket, body: "…", summary_until: "…", handback: false }
 *         refused: claim it first             # the call must fail, with this in the error
 *       - view: [alpha-lead]
 *       - wake: alpha-lead                   # the loop wakes the agent now; its backlog head sinks
 *       - expect:
 *           alpha-lead: { ticket: $ticket, backlog: actionable, act: true, wake: triage }
 *       - pause: look at the web UI
 */
import { parse } from "yaml";
import { TIER_LABEL, type ViewRow } from "./view.js";

export type ModeratorAction = "approve" | "reject" | "accept" | "refuse" | "comment";
export type Backlog = "hot" | "actionable" | "follow-up" | "waiting" | "blocked" | "none";
export type Wake = "triage" | "followup" | "waiting" | "blocked" | "event" | "none";

export interface SeatExpectation {
    ticket: unknown;
    backlog?: Backlog;
    act?: boolean;
    claim?: boolean;
    gated?: boolean;
    last_actor?: string;
    wake?: Wake;
}

export type Step =
    | { kind: "mcp"; agent: string; tool: string; args: Record<string, unknown>; save: Record<string, string>; refused: string | null }
    | { kind: "moderator"; action: ModeratorAction; target: unknown; body: string | null }
    | { kind: "view"; agents: string[] }
    | { kind: "expect"; seats: Record<string, SeatExpectation> }
    | { kind: "wake"; agent: string }
    | { kind: "pause"; message: string };

export interface Scenario {
    name: string;
    steps: Step[];
}

const MODERATOR_ACTIONS: readonly ModeratorAction[] = ["approve", "reject", "accept", "refuse", "comment"];
const BACKLOGS: readonly Backlog[] = ["hot", "actionable", "follow-up", "waiting", "blocked", "none"];
const WAKES: readonly Wake[] = ["triage", "followup", "waiting", "blocked", "event", "none"];

export function parseScenario(text: string, agents: readonly string[]): Scenario {
    const raw = (parse(text) ?? {}) as { name?: unknown; steps?: unknown };
    const fail = (i: number | null, why: string): never => {
        throw new Error(`scenario${i === null ? "" : ` step ${i + 1}`}: ${why}`);
    };
    const name = typeof raw.name === "string" && raw.name ? raw.name : fail(null, "a name is required");
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail(null, "steps must be a non-empty list");
    const knownAgent = (i: number, id: string) => {
        if (!agents.includes(id)) fail(i, `unknown agent ${id} (cohort: ${agents.join(", ")})`);
        return id;
    };

    const steps = (raw.steps as Record<string, unknown>[]).map((s, i): Step => {
        if (!s || typeof s !== "object") return fail(i, "a step is a mapping");
        if ("pause" in s) return { kind: "pause", message: String(s.pause ?? "") };
        if ("wake" in s) return { kind: "wake", agent: knownAgent(i, String(s.wake)) };
        if ("view" in s) {
            const list = Array.isArray(s.view) ? s.view : [s.view];
            return { kind: "view", agents: list.map((a) => knownAgent(i, String(a))) };
        }
        if ("expect" in s) {
            const seats = (s.expect ?? {}) as Record<string, Record<string, unknown>>;
            for (const [agent, e] of Object.entries(seats)) {
                knownAgent(i, agent);
                if (!e || e.ticket === undefined) fail(i, `expect.${agent} needs a ticket`);
                if (e.backlog !== undefined && !BACKLOGS.includes(e.backlog as Backlog)) fail(i, `backlog must be one of ${BACKLOGS.join(", ")}`);
                if (e.wake !== undefined && !WAKES.includes(e.wake as Wake)) fail(i, `wake must be one of ${WAKES.join(", ")}`);
            }
            return { kind: "expect", seats: seats as unknown as Record<string, SeatExpectation> };
        }
        if ("moderator" in s) {
            const [action, target] = String(s.moderator).trim().split(/\s+/, 2);
            if (!MODERATOR_ACTIONS.includes(action as ModeratorAction)) fail(i, `moderator action must be one of ${MODERATOR_ACTIONS.join(", ")}`);
            if (target === undefined) fail(i, `moderator: ${action} needs a target (a ticket or comment id, or $name)`);
            if (action === "comment" && typeof s.body !== "string") fail(i, "moderator: comment needs a body");
            return { kind: "moderator", action: action as ModeratorAction, target, body: typeof s.body === "string" ? s.body : null };
        }
        const keys = Object.keys(s).filter((k) => !["args", "save", "refused"].includes(k));
        if (keys.length !== 1) fail(i, "an agent step names one agent: `<agent>: <tool>`");
        const agent = knownAgent(i, keys[0]!);
        return {
            kind: "mcp",
            agent,
            tool: typeof s[agent] === "string" ? s[agent] as string : fail(i, `${agent}: needs a tool name`),
            args: (s.args ?? {}) as Record<string, unknown>,
            save: (s.save ?? {}) as Record<string, string>,
            refused: typeof s.refused === "string" ? s.refused : null,
        };
    });
    return { name, steps };
}

/** Replace every `$name` string, however deep, by its saved value. */
export function substitute<T>(value: T, vars: Readonly<Record<string, unknown>>): T {
    if (typeof value === "string" && /^\$[A-Za-z_][\w]*$/.test(value)) {
        const key = value.slice(1);
        if (!(key in vars)) throw new Error(`${value} is not saved yet`);
        return vars[key] as T;
    }
    if (Array.isArray(value)) return value.map((v) => substitute(v, vars)) as T;
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)])) as T;
    }
    return value;
}

/** Read a dotted path (`id`, `claim.claimant`) out of a tool result. */
export function pick(result: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), result);
}

/** An agent's seat, as the runner fetches it. */
export interface Seat {
    rows: ViewRow[];
    unreadPings: number;
    head: ViewRow | null;
}

function wakeOf(seat: Seat, ticketId: number): Wake | `about #${number}` {
    if (seat.unreadPings > 0) return "event";
    if (!seat.head || seat.head.backlog_tier === null) return "none";
    if (seat.head.id !== ticketId) return `about #${seat.head.id}`;
    const t = seat.head.backlog_tier;
    return t <= 1 ? "triage" : t === 2 ? "followup" : t === 3 ? "waiting" : "blocked";
}

/** Every way the seat differs from the expectation; empty when it matches. */
export function matchSeat(expect: SeatExpectation, seat: Seat): string[] {
    const id = Number(expect.ticket);
    const row = seat.rows.find((r) => r.id === id) ?? null;
    const misses: string[] = [];
    const check = (what: string, want: unknown, got: unknown) => {
        if (want !== undefined && want !== got) misses.push(`${what}: expected ${String(want)}, got ${String(got)}`);
    };
    check("backlog", expect.backlog, row?.backlog_tier == null ? "none" : TIER_LABEL[row.backlog_tier]);
    check("act", expect.act, row?.actionable ?? false);
    check("claim", expect.claim, row?.claimable ?? false);
    check("gated", expect.gated, row?.gated_by_decision ?? false);
    check("last_actor", expect.last_actor, row?.last_actor ?? null);
    if (expect.wake !== undefined) {
        const got = wakeOf(seat, id);
        // A wake about another ticket is still "no wake about this one".
        if (!(expect.wake === "none" && got.startsWith("about #")) && got !== expect.wake) {
            misses.push(`wake: expected ${expect.wake}, got ${got}`);
        }
    }
    if (!row && (expect.act || expect.claim || (expect.backlog && expect.backlog !== "none"))) {
        misses.push(`#${id} is not among the open tickets of this agent's project`);
    }
    return misses;
}
