/**
 * #3063 — the subjects of version 1, and where their events come from: every
 * event the daemon already broadcasts (`ws.ts`), and the pings. A subscriber
 * gets data, built by the same code as the matching read.
 */
import { z } from "zod";
import { consumerIdOf, defineMethod, getMethod, Refusal, type Caller } from "../methods.js";
import { consumerEntries, consumerEntryFor } from "./consumer.js";
import { defineSubject, publish, sendTo, SKIP, subscribe, subscriptionsOf, unsubscribe, type SubjectSpec, type Subscription } from "../subscriptions.js";
import { onBroadcast, type WsEvent } from "../../ws.js";
import { getMessage, ticketUnreadFlags, unreadPingCount, type Message } from "../../db.js";
import { getAgentBar, listAgentBars } from "../../agent-bar-store.js";
import { onPing } from "../../event-bus.js";
import { wakeFocusHidesTicket } from "../../db/backlog-rules.js";
import { parseMeta } from "../../questions.js";
import { buildInboxRow, buildInboxRowContext, inboxRowDeadline, type InboxRowContext } from "../../api/inbox-row.js";
import { buildPilotFacts, pilotFields } from "../../api/inbox-pilot.js";

/** An agent's own data: a human, or the agent itself. */
function ownOrHuman(caller: Caller, id: string, what: string): Refusal | null {
    if (id === "*") return caller.kind === "human" ? null : new Refusal(403, `every agent's ${what} is a human's view`);
    return id === caller.consumer_id || caller.kind === "human" ? null : new Refusal(403, `an agent's ${what} is readable by a human or by the agent itself`);
}

const consumers = (caller: Caller) => ["human", "agent"].includes(caller.kind) ? null : new Refusal(403, "a consumer's subject");

function idOf(sub: Subscription): string {
    return sub.parts[1];
}

// ---- agent.<id>.bar -----------------------------------------------------------

defineSubject({
    pattern: "agent.*.bar",
    wildcard: true,
    access: (caller, id) => ownOrHuman(caller, id, "bar"),
    value: (sub) => {
        const id = idOf(sub);
        if (id !== "*") return getAgentBar(id);
        return Object.fromEntries(listAgentBars().map((b) => [b.consumer_id, b]));
    },
});

// ---- agent.<id>.state ---------------------------------------------------------

/**
 * #3070 — each event is the consumer's whole entry as `consumer.list` builds
 * it, pushed only when it changed; `null` once the consumer is deleted.
 */
defineSubject({
    pattern: "agent.*.state",
    wildcard: true,
    access: (caller) => consumers(caller),
    value: (sub) => {
        const id = idOf(sub);
        const all = consumerEntries();
        const mine = id === "*" ? all : all.filter((c) => c.consumer_id === id);
        sub.state.sent = new Map(mine.map((c) => [c.consumer_id, JSON.stringify(c)]));
        if (id !== "*") return mine[0] ?? null;
        return Object.fromEntries(all.map((c) => [c.consumer_id, c]));
    },
    deliver: (sub, subject) => {
        const id = subject.split(".")[1];
        const sent = sub.state.sent as Map<string, string>;
        const entry = consumerEntryFor(id);
        const json = JSON.stringify(entry);
        if (sent.get(id) === json) return SKIP;
        sent.set(id, json);
        // A deleted consumer: `null`, sent as such.
        return entry;
    },
});

// ---- ticket.<id> --------------------------------------------------------------

defineSubject({
    pattern: "ticket.*",
    access: (caller) => consumers(caller),
    value: (sub) => getMethod("ticket.get")!.run(sub.caller, { id: sub.parts[1], full: true }),
});

// ---- project.<p>.tickets ------------------------------------------------------

/** What every project view hears of a ticket that moved in any way. */
interface TicketMoved { ticket_id: number; project: string }

/** What a view holds of each row it sent: to diff, to route a remove, to know when time changes it. */
interface Sent { project: string; json: string; deadline: number | null }

type TurnRow = { id: number; project: string } & Record<string, unknown>;

function viewOpts(sub: Subscription) {
    return { open: sub.opts.open === true, include_postponed: sub.opts.include_postponed === true };
}

/**
 * The rows of `tickets` for one subscriber, those in its view, with the moment
 * each changes with time alone. `shared` (the context of one event) is built
 * once for every subscriber: only the unread flags and the pilot's fields are
 * the subscriber's own.
 */
function turnRows(sub: Subscription, tickets: Message[], shared?: InboxRowContext): { row: TurnRow; deadline: number | null }[] {
    const me = consumerIdOf(sub.caller);
    const ctx = shared ?? buildInboxRowContext(tickets, me);
    const own = { ...ctx, unreadMap: ticketUnreadFlags(me, tickets.map((t) => t.id)) };
    const { open, include_postponed } = viewOpts(sub);
    const out: { row: TurnRow; deadline: number | null }[] = [];
    const rows = tickets.map((t) => ({ t, row: buildInboxRow(t, own) }))
        .filter(({ row }) => !(open && row.closed) && (include_postponed || !row.postponed));
    const byProject = new Map<string, typeof rows>();
    for (const r of rows) byProject.set(r.t.project, [...(byProject.get(r.t.project) ?? []), r]);
    for (const [project, list] of byProject) {
        const facts = buildPilotFacts(list.map((r) => r.row), me, project);
        for (const { t, row } of list) {
            out.push({
                row: { ...row, ...pilotFields(row, facts.get(row.id)!, me, sub.caller.kind === "human") } as TurnRow,
                deadline: inboxRowDeadline(t, own),
            });
        }
    }
    return out;
}

function sentOf(sub: Subscription): Map<number, Sent> {
    return sub.state.sent as Map<number, Sent>;
}

/** Diff one ticket's row against what the view holds: an upsert, a remove, or nothing. */
function diffRow(sub: Subscription, ticketId: number, fresh: { row: TurnRow; deadline: number | null } | undefined) {
    const sent = sentOf(sub);
    const before = sent.get(ticketId);
    if (fresh) {
        const json = JSON.stringify(fresh.row);
        sent.set(ticketId, { project: fresh.row.project, json, deadline: fresh.deadline });
        armDeadline(fresh.deadline);
        return before?.json === json ? SKIP : { op: "upsert", row: fresh.row };
    }
    if (!before) return SKIP;
    sent.delete(ticketId);
    return { op: "remove", id: ticketId, project: before.project };
}

const sharedCtx = new WeakMap<object, InboxRowContext>();

const projectTickets: SubjectSpec = {
    pattern: "project.*.tickets",
    // `project.*.tickets`: every project the subscriber sees, and the ones created later.
    wildcard: true,
    // The rows a view holds live on the subscription: a replay onto the current
    // rows could keep one that left while the client was away.
    replay: false,
    access: (caller) => consumers(caller),
    value: (sub) => {
        const project = sub.parts[1] === "*" ? undefined : sub.parts[1];
        const out = getMethod("inbox.list")!.run(sub.caller, { project, view: "turn", ...viewOpts(sub) }) as { rows: TurnRow[] };
        const sent = new Map<number, Sent>();
        sub.state.sent = sent;
        // What time will change: the same rows' deadlines, computed once for the view.
        const tickets = out.rows.map((r) => getMessage(r.id)).filter((t): t is Message => !!t);
        const ctx = buildInboxRowContext(tickets, consumerIdOf(sub.caller), project);
        const byId = new Map(tickets.map((t) => [t.id, t]));
        for (const row of out.rows) {
            const t = byId.get(row.id);
            const deadline = t ? inboxRowDeadline(t, ctx) : null;
            sent.set(row.id, { project: row.project, json: JSON.stringify(row), deadline });
            armDeadline(deadline);
        }
        if (project !== undefined) return out.rows;
        const byProject: Record<string, TurnRow[]> = {};
        for (const row of out.rows) (byProject[row.project] ??= []).push(row);
        return byProject;
    },
    // Every ticket event: a ticket moved out of this project must leave the view.
    hears: (_sub, subject) => subject === "tickets",
    deliver: (sub, _subject, data) => {
        const ev = data as TicketMoved;
        const t = getMessage(ev.ticket_id);
        const mine = t && t.kind === "ticket_created" && (sub.parts[1] === "*" || t.project === sub.parts[1]);
        let fresh: { row: TurnRow; deadline: number | null } | undefined;
        if (mine) {
            let ctx = sharedCtx.get(ev);
            if (!ctx) {
                ctx = buildInboxRowContext([t], consumerIdOf(sub.caller), t.project);
                sharedCtx.set(ev, ctx);
            }
            fresh = turnRows(sub, [t], ctx)[0];
        }
        return diffRow(sub, ev.ticket_id, fresh);
    },
    eventSubject: (_sub, out) => {
        const o = out as { row?: { project: string }; project?: string };
        return `project.${o.row?.project ?? o.project}.tickets`;
    },
};
defineSubject(projectTickets);

/**
 * Rows change with time alone (`hot` cooling, a step going stale, a hold or a
 * snooze ending). One timer, at the earliest such moment across every view:
 * then the rows due are rebuilt, and a row that changed is pushed.
 */
let timer: NodeJS.Timeout | null = null;
let timerAt = Infinity;

function armDeadline(at: number | null): void {
    if (at === null || at >= timerAt) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    // A little past the moment, so the rebuilt row is past it too.
    timer = setTimeout(sweepDeadlines, Math.max(0, at - Date.now()) + 50);
    timer.unref?.();
}

export function sweepDeadlines(now = Date.now()): void {
    timer = null;
    timerAt = Infinity;
    for (const sub of subscriptionsOf(projectTickets)) {
        const due = [...sentOf(sub).entries()].filter(([, s]) => s.deadline !== null && s.deadline <= now).map(([id]) => id);
        if (due.length === 0) continue;
        const tickets = due.map((id) => getMessage(id)).filter((t): t is Message => !!t);
        const fresh = new Map(turnRows(sub, tickets).map((r) => [r.row.id, r]));
        for (const id of due) {
            const out = diffRow(sub, id, fresh.get(id));
            if (out !== SKIP) sendTo(sub, out);
        }
    }
    let next = Infinity;
    for (const sub of subscriptionsOf(projectTickets)) {
        for (const s of sentOf(sub).values()) if (s.deadline !== null && s.deadline > now && s.deadline < next) next = s.deadline;
    }
    if (next !== Infinity) armDeadline(next);
}

// ---- user.<id>.pings ----------------------------------------------------------

const pingSources = new Map<string, { count: number; off: () => void }>();

/**
 * What a ping points at, so a client need not read it again: the comment (or
 * the ticket), its ticket's title and project, its author, kind, status, and
 * the decision it carries.
 */
function pingedMessage(p: { ticket_id?: number; comment_id?: number }) {
    const m = getMessage(p.comment_id ?? p.ticket_id ?? 0);
    if (!m) return null;
    const ticket = m.kind === "ticket_created" ? m : m.ticket_id ? getMessage(m.ticket_id) : null;
    return {
        id: m.id,
        hashid: m.hashid ?? null,
        kind: m.kind,
        status: m.status,
        by_agent: m.by_agent,
        created_at: m.created_at,
        project: m.project,
        ticket_id: ticket?.id ?? null,
        title: ticket?.title ?? null,
        decision: parseMeta(m.meta ?? null).decision ?? null,
    };
}

defineSubject({
    pattern: "user.*.pings",
    access: (caller, id) => (id === caller.consumer_id ? null : new Refusal(403, "one's own pings only")),
    value: (sub) => {
        const id = idOf(sub);
        const src = pingSources.get(id);
        if (src) src.count++;
        else {
            pingSources.set(id, {
                count: 1,
                off: onPing(id, (payload) => {
                    // #2525 — as on the event stream: a ping outside the wake focus is not pushed.
                    if (payload.ticket_id !== undefined && wakeFocusHidesTicket(id, payload.ticket_id)) return;
                    publish(`user.${id}.pings`, { ...payload, message: pingedMessage(payload) });
                }),
            });
        }
        return { unread: unreadPingCount(id) };
    },
    release: (sub) => {
        const src = pingSources.get(idOf(sub));
        if (src && --src.count === 0) {
            src.off();
            pingSources.delete(idOf(sub));
        }
    },
});

// ---- the sources --------------------------------------------------------------

const MESSAGE_EVENTS = new Set(["message_created", "message_decided", "message_edited", "message_noted", "message_tagged"]);

function ticketOfEvent(ev: WsEvent): Message | null {
    const d = ev.data as Partial<Message> & { message_id?: number };
    const m = ev.type === "message_tagged" ? getMessage(Number(d.message_id)) : (d as Message);
    if (!m || typeof m.id !== "number") return null;
    if (m.kind === "ticket_created") return m;
    return m.ticket_id ? getMessage(m.ticket_id) : null;
}

onBroadcast((ev) => {
    const d = ev.data as Record<string, unknown> | null;
    if (ev.type === "agent_bar" && d && typeof d.consumer_id === "string") {
        publish(`agent.${d.consumer_id}.bar`, d);
        return;
    }
    if (ev.type === "consumer_changed" && d && typeof d.consumer_id === "string") {
        publish(`agent.${d.consumer_id}.state`, d);
        return;
    }
    if (MESSAGE_EVENTS.has(ev.type)) {
        const t = ticketOfEvent(ev);
        if (!t) return;
        const message = ev.type === "message_tagged" ? d : ev.data;
        publish(`ticket.${t.id}`, { type: ev.type, message });
        publish("tickets", { ticket_id: t.id, project: t.project } satisfies TicketMoved);
    }
});

// ---- the methods --------------------------------------------------------------

/**
 * Subscribe to a subject: its current value, then its changes as `bus.event`
 * notifications. With `since` (the epoch and the last `seq` received), what
 * was missed instead, while the daemon still holds it.
 */
defineMethod({
    name: "bus.subscribe",
    who: ["human", "agent"],
    params: z.object({
        subject: z.string().min(1),
        since: z.object({ epoch: z.string(), seq: z.number().int().nonnegative() }).optional(),
        open: z.boolean().optional(),
        include_postponed: z.boolean().optional(),
    }),
    run: (caller, p) => subscribe(caller, p.subject, p.since, { open: p.open, include_postponed: p.include_postponed }),
});

defineMethod({
    name: "bus.unsubscribe",
    who: ["human", "agent"],
    params: z.object({ id: z.string() }),
    run: (caller, p) => ({ unsubscribed: unsubscribe(caller, p.id) }),
});
