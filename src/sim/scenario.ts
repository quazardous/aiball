/**
 * A board simulator scenario: gestures by simulated agents and the moderator,
 * with views and expectations in between (tests/sim/scenarios/*.yaml).
 *
 * Pure: parsing, `$name` substitution and matching an expectation against an
 * agent's seat live here, where a unit test reaches them; the runner
 * (tests/sim/sim.ts) only performs the gestures and fetches the seats.
 *
 *     name: a sole participant keeps its ticket after a handback
 *     cohort: tests/sim/cohorts/two-owners.yaml   # optional; default tests/sim/cohort.yaml
 *     cooldown: 60s                               # optional; the loop's backlog cooldown, default 1h
 *     steps:
 *       - alpha-lead: ticket_new             # an agent calls an MCP tool
 *         args: { title: "…" }
 *         save: { ticket: id }               # $ticket = the result's `id`
 *       - moderator: approve $ticket          # approve | reject | accept | refuse | comment
 *                                             # | close | reopen | snooze $t 2m | assign $t <agent>
 *       - alpha-lead: ticket_reply
 *         args: { target_id: $ticket, body: "…", summary_until: "…", handback: false }
 *         refused: claim it first             # the call must fail, with this in the error
 *       - moderator: accept $old_plan
 *         may_fail: true                     # a pin-down: a refusal is reported, the scenario goes on
 *       - view: [alpha-lead]
 *       - wake: alpha-lead                   # the loop wakes the agent now; its backlog head sinks
 *       - sleep: 75                          # seconds
 *       - expect:
 *           alpha-lead: { ticket: $ticket, backlog: actionable, act: true, wake: triage, rank: 1, events: [plan_accepted] }
 *       - pause: look at the web UI
 */
import { parse } from "yaml";
import { TIER_LABEL, type ViewRow } from "./view.js";

export type ModeratorAction = "approve" | "reject" | "accept" | "refuse" | "comment" | "close" | "reopen" | "snooze" | "assign";
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
    /** 1-based position among the agent's open tickets, in `ticket_list`'s work order; 0 = not listed. */
    rank?: number;
    /** Kinds of the agent's unread events on this ticket, oldest first. */
    events?: string[];
}

export type Step =
    | { kind: "mcp"; agent: string; tool: string; args: Record<string, unknown>; save: Record<string, string>; refused: string | null }
    | { kind: "moderator"; action: ModeratorAction; target: unknown; arg: string | null; body: string | null; mayFail: boolean }
    | { kind: "view"; agents: string[] }
    | { kind: "expect"; seats: Record<string, SeatExpectation> }
    | { kind: "wake"; agent: string }
    | { kind: "sleep"; seconds: number }
    | { kind: "pause"; message: string };

export interface Scenario {
    name: string;
    /** Cohort file for this scenario, relative to the repository root; null = the default one. */
    cohort: string | null;
    /**
     * The backlog cooldown the loop is played with, in seconds (`cooldown: 60s`;
     * default an hour, the loop's own). Short, a scenario can watch a sunk
     * ticket come back without waiting an hour.
     */
    cooldownSec: number;
    steps: Step[];
}

/** The loop's backlog cooldown when a scenario names none. */
export const DEFAULT_COOLDOWN_SEC = 3600;

const MODERATOR_ACTIONS: readonly ModeratorAction[] = ["approve", "reject", "accept", "refuse", "comment", "close", "reopen", "snooze", "assign"];
const BACKLOGS: readonly Backlog[] = ["hot", "actionable", "follow-up", "waiting", "blocked", "none"];
const WAKES: readonly Wake[] = ["triage", "followup", "waiting", "blocked", "event", "none"];

/** `90`, `90s`, `2m`, `1h` → seconds; null when unreadable. */
export function parseDuration(text: string): number | null {
    const m = /^(\d+)\s*([smh]?)$/.exec(text.trim());
    if (!m) return null;
    return Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2]!]!;
}

/** The cohort a scenario asks for, readable before the board (and its agents) exist. */
export function scenarioCohort(text: string): string | null {
    const raw = (parse(text) ?? {}) as { cohort?: unknown };
    return typeof raw.cohort === "string" && raw.cohort ? raw.cohort : null;
}

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
        if ("sleep" in s) {
            const seconds = parseDuration(String(s.sleep));
            return seconds === null || seconds <= 0 ? fail(i, "sleep takes a duration: 30, 30s, 2m") : { kind: "sleep", seconds };
        }
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
                if (e.rank !== undefined && !(Number.isInteger(e.rank) && (e.rank as number) >= 0)) fail(i, "rank is a position from 1, or 0 for not listed");
                if (e.events !== undefined && !Array.isArray(e.events)) fail(i, "events is a list of event kinds");
            }
            return { kind: "expect", seats: seats as unknown as Record<string, SeatExpectation> };
        }
        if ("moderator" in s) {
            const [action, target, ...rest] = String(s.moderator).trim().split(/\s+/);
            if (!MODERATOR_ACTIONS.includes(action as ModeratorAction)) fail(i, `moderator action must be one of ${MODERATOR_ACTIONS.join(", ")}`);
            if (target === undefined) fail(i, `moderator: ${action} needs a target (a ticket or comment id, or $name)`);
            const arg = rest.length > 0 ? rest.join(" ") : null;
            if (action === "comment" && typeof s.body !== "string") fail(i, "moderator: comment needs a body");
            if (action === "snooze" && (arg === null || parseDuration(arg) === null)) fail(i, "moderator: snooze $ticket <duration>, e.g. 2m");
            if (action === "assign") {
                if (arg === null) fail(i, "moderator: assign $ticket <agent>");
                knownAgent(i, arg!);
            }
            return { kind: "moderator", action: action as ModeratorAction, target, arg, body: typeof s.body === "string" ? s.body : null, mayFail: s.may_fail === true };
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
    const cooldownRaw = (raw as { cooldown?: unknown }).cooldown;
    let cooldownSec = DEFAULT_COOLDOWN_SEC;
    if (cooldownRaw !== undefined) {
        const seconds = parseDuration(String(cooldownRaw));
        if (seconds === null || seconds <= 0) fail(null, "cooldown takes a duration: 60, 60s, 5m");
        cooldownSec = seconds!;
    }
    return { name, cohort: scenarioCohort(text), cooldownSec, steps };
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

/** An unread event, as the agent's queue holds it. A ticket's creation is its own ticket. */
export interface UnreadEvent {
    id: number;
    kind: string;
    ticket_id: number | null;
}

/** An agent's seat, as the runner fetches it. `rows` come in `ticket_list`'s work order. */
export interface Seat {
    rows: ViewRow[];
    unreadPings: number;
    head: ViewRow | null;
    unread: UnreadEvent[];
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
    check("rank", expect.rank, seat.rows.findIndex((r) => r.id === id) + 1);
    if (expect.events !== undefined) {
        const got = seat.unread.filter((e) => (e.ticket_id ?? e.id) === id).map((e) => e.kind);
        if (got.join(",") !== expect.events.join(",")) misses.push(`events: expected [${expect.events.join(", ")}], got [${got.join(", ")}]`);
    }
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
