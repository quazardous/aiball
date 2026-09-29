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
import { onControl, onPing, onSignal } from "../../event-bus.js";
import { listPendingSignals } from "../../db/signals.js";
import { drainPrompts } from "../../loop-prompts.js";
import { presenceConnect, presenceDisconnect } from "../../live-presence.js";
import { onCounters, refreshCounters } from "../../agent-counters.js";
import { wakeFocusHidesTicket } from "../../db/backlog-rules.js";
import { parseMeta } from "../../questions.js";
import { buildInboxRow, buildInboxRowContext, inboxRowDeadline, type InboxRowContext } from "../../queries/inbox-row.js";
import { buildPilotFacts, pilotFields } from "../../queries/inbox-pilot.js";

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
    doc: { value: "the agent's bar, as consumer.bar gives it, or null; with *, keyed by agent", event: "the bar, whenever it changes or goes stale" },
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
    doc: { value: "the agent's entry, as consumer.list gives it; with *, keyed by agent", event: "the whole entry again whenever it changed; null once the consumer is deleted" },
    wildcard: true,
    access: (caller) => consumers(caller),
    // Empty on a resumed subscription: its first event per consumer is then pushed whole.
    setup: (sub) => { sub.state.sent = new Map<string, string>(); },
    value: (sub) => {
        const id = idOf(sub);
        const all = consumerEntries();
        const mine = id === "*" ? all : all.filter((c) => c.consumer_id === id);
        const sent = sub.state.sent as Map<string, string>;
        for (const c of mine) sent.set(c.consumer_id, JSON.stringify(c));
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
    doc: { value: "what ticket.get gives with full: true", event: "{ type, message }: a message created, edited, decided, noted or tagged on the ticket" },
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
    doc: { value: "the rows inbox.list gives with view: turn (options open, include_postponed); with *, keyed by project", event: "{ op: upsert, row } or { op: remove, id, project }; a row is pushed when it changed, time-derived fields included" },
    // `project.*.tickets`: every project the subscriber sees, and the ones created later.
    wildcard: true,
    // The rows a view holds live on the subscription: a replay onto the current
    // rows could keep one that left while the client was away.
    replay: false,
    access: (caller) => consumers(caller),
    setup: (sub) => { sub.state.sent = new Map<number, Sent>(); },
    value: (sub) => {
        const project = sub.parts[1] === "*" ? undefined : sub.parts[1];
        const out = getMethod("inbox.list")!.run(sub.caller, { project, view: "turn", ...viewOpts(sub) }) as { rows: TurnRow[] };
        const sent = sentOf(sub);
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

/** Tests only: how many subscriptions hold `user`'s ping source; null when it is unwired. */
export function pingSourceCountForTests(user: string): number | null {
    return pingSources.get(user)?.count ?? null;
}

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
    doc: { value: "{ unread }", event: "a ping, and message: what it points at (kind, status, author, project, ticket title, decision)" },
    access: (caller, id) => (id === caller.consumer_id ? null : new Refusal(403, "one's own pings only")),
    // The ping source is wired for every subscription, a resumed one included (#3089).
    setup: (sub) => {
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
    },
    value: (sub) => ({ unread: unreadPingCount(idOf(sub)) }),
    release: (sub) => {
        const src = pingSources.get(idOf(sub));
        if (src && --src.count === 0) {
            src.off();
            pingSources.delete(idOf(sub));
        }
    },
});

// ---- agent.<id>.events --------------------------------------------------------

/**
 * #3068 — what a loop's event stream carried (`/api/events`), for the loop
 * itself: its pings (#2525: one outside the wake focus is not pushed, the loop
 * wakes on this push), the loop controls (#442 kill, #451 prompt, #3074
 * restart), and external signals (#2255). The subscription IS the loop's
 * liveness (#395): open, the loop is running; gone, after a grace, it is not.
 * On every subscribe, the signals still waiting and the prompts spooled while
 * the loop was away go out first, right after the answer. Nothing is replayed
 * on `since`: the value tells the unread count, and the waiting signals come
 * again, as they did on a reconnected stream.
 */
defineSubject({
    pattern: "agent.*.events",
    replay: false,
    doc: {
        value: "{ consumer_id, unread, counters }",
        event: "`{ event, data }`: `ping` (the ping, outside the wake focus not sent), `control` (`kill`, `prompt`, `restart_claude`), `signal`, or `counters` (the agent's counters, when a number changed)",
    },
    access: (caller, id) => (id === caller.consumer_id ? null : new Refusal(403, "a loop's own events only")),
    setup: (sub) => {
        const id = idOf(sub);
        const offs = [
            onPing(id, (payload) => {
                if (payload.ticket_id !== undefined && wakeFocusHidesTicket(id, payload.ticket_id)) return;
                sendTo(sub, { event: "ping", data: payload });
            }),
            onControl(id, (payload) => sendTo(sub, { event: "control", data: payload })),
            onSignal(id, (payload) => sendTo(sub, { event: "signal", data: payload })),
            onCounters(id, (counters) => sendTo(sub, { event: "counters", data: counters })),
        ];
        sub.state.off = () => { for (const off of offs) off(); };
        presenceConnect(id, sub.opts.source === "ui" ? "ui" : "terminal");
        // After the answer: an event reaches a subscription only once it is registered.
        setImmediate(() => {
            for (const pending of listPendingSignals(id)) sendTo(sub, { event: "signal", data: pending });
            for (const text of drainPrompts(id)) sendTo(sub, { event: "control", data: { action: "prompt", text } });
        });
    },
    // The loop starts from counters computed now: its bar shows them at once.
    value: (sub) => ({ consumer_id: idOf(sub), unread: unreadPingCount(idOf(sub)), counters: refreshCounters(idOf(sub)) }),
    release: (sub) => {
        (sub.state.off as (() => void) | undefined)?.();
        presenceDisconnect(idOf(sub));
    },
});

// ---- board.events -------------------------------------------------------------

/**
 * #3068 — every event the board broadcasts, as it is: `{ type, data }`, the
 * feed the web UI patches its views from. The subjects above give the same changes as
 * rows and views; this one keeps a client's own patching as it is.
 */
defineSubject({
    pattern: "board.events",
    doc: { value: "null: the feed has no state of its own", event: "a broadcast event, `{ type, data }`" },
    access: (caller) => consumers(caller),
    value: () => null,
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
    publish("board.events", ev);
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
        ticketMoved(t, ev.type, ev.type === "message_tagged" ? d : ev.data);
    }
});

/**
 * A ticket changed: its thread hears the event, and its row is built again in
 * every `project.*.tickets` view. #3163 — also called straight, for a change
 * the board does not broadcast (the auto-close of an accepted resolution or
 * wontfix, kept off `board.events` so the web shows one toast), without which
 * the views keep the row as it was before the close.
 */
export function ticketMoved(t: Pick<Message, "id" | "project">, type: string, message: unknown): void {
    publish(`ticket.${t.id}`, { type, message });
    publish("tickets", { ticket_id: t.id, project: t.project } satisfies TicketMoved);
}

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
        /** `agent.<id>.events`: how the loop was launched, `terminal` or `ui` (#395). */
        source: z.enum(["terminal", "ui"]).optional(),
        /** `agent.<id>.screen`: whether this viewer may type (on the session host, an interactive client). */
        typing: z.boolean().optional(),
        /** `agent.<id>.screen`, with `typing`: the size this viewer would like once it types. */
        size: z.object({ rows: z.number().int().min(1).max(1000), cols: z.number().int().min(1).max(1000) }).optional(),
    }),
    run: (caller, p) => subscribe(caller, p.subject, p.since, { open: p.open, include_postponed: p.include_postponed, source: p.source, typing: p.typing, size: p.size }),
});

/** End a subscription: no more events for it. Closing the connection ends them all. */
defineMethod({
    name: "bus.unsubscribe",
    who: ["human", "agent"],
    params: z.object({ id: z.string() }),
    run: (caller, p) => ({ unsubscribed: unsubscribe(caller, p.id) }),
});
