/**
 * #3063 — subjects and subscriptions. A client subscribes to a subject and
 * gets its current value, then every change as data: never a signal to go and
 * read again. Events carry one `seq`, increasing across the daemon, and the
 * daemon keeps the latest ones, so a client that reconnects gets what it
 * missed instead of the whole value. See docs/API-BUS.md.
 */
import { randomUUID } from "node:crypto";
import { Refusal, type Caller } from "./methods.js";
import { ERROR_CODES } from "../domain.js";

/** Changes when the daemon restarts: a `since` from before means nothing. */
export const BUS_EPOCH = randomUUID();

/** How many events the daemon keeps for a client to catch up. */
export const REPLAY_EVENTS = 4096;

/** A connection's side of the bus: where its subscriptions' events go. */
export interface BusSession {
    subscriptions: Map<string, Subscription>;
    notify(method: string, params: unknown): void;
}

export interface Subscription {
    id: string;
    /** As asked: a segment may be `*`. */
    subject: string;
    parts: string[];
    spec: SubjectSpec;
    caller: Caller;
    opts: Record<string, unknown>;
    /** What the subject's spec keeps per subscription (the rows a view holds). */
    state: Record<string, unknown>;
    session: BusSession;
}

export interface SubjectSpec {
    /** Segments, `*` where an id goes: `agent.*.bar`. */
    pattern: string;
    /** Whether `*` may be asked in place of the id. */
    wildcard?: boolean;
    /**
     * #3294 — about the machine that answers (its sessions): a proxy node
     * serves the subscription itself, for its own machine; the core refuses it
     * to a relayed caller, as it would describe the core's machine.
     */
    machine?: boolean;
    /**
     * false: a `since` always gets the value again. For a view whose rows the
     * spec keeps per subscription, events replayed on the current rows could
     * leave behind one that left the view while the client was away.
     */
    replay?: boolean;
    access(caller: Caller, id: string): Refusal | null;
    /**
     * #3089 — what a subscription needs wired or kept, whichever way it starts:
     * called on every subscribe, BEFORE the value or the replay. A resumed
     * subscription (`since`) does not compute its value, so nothing a
     * subscription relies on may live in `value`.
     */
    setup?(sub: Subscription): void;
    /** The current value, for one id or (`*`) all of them as `id → value`. Computes; wires nothing (see `setup`). */
    value(sub: Subscription): unknown;
    /** Which published subjects this subscription hears; by default its own. */
    hears?(sub: Subscription, subject: string): boolean;
    /** What the subscriber receives of an event, or `SKIP` for nothing (`null` is data). */
    deliver?(sub: Subscription, subject: string, data: unknown): unknown;
    /** What the published contract says of the value and of an event (#3069). */
    doc?: { value: string; event: string };
    /** Called once the subscription is gone (a source to let go of). */
    release?(sub: Subscription): void;
    /** The concrete subject an event goes out under, when it hears wider (`hears`). */
    eventSubject?(sub: Subscription, out: unknown): string;
}

const specs: SubjectSpec[] = [];

/** What `deliver` returns when this subscriber gets nothing of an event. */
export const SKIP: unique symbol = Symbol("skip");

export function defineSubject(spec: SubjectSpec): void {
    specs.push(spec);
}

/** Every subject defined, for the published contract. */
export function subjectSpecs(): readonly SubjectSpec[] {
    return specs;
}

interface Published { seq: number; subject: string; data: unknown }
let seq = 0;
const ring: Published[] = [];
const all = new Set<Subscription>();

export function currentSeq(): number {
    return seq;
}

function globMatch(pattern: string[], subject: string[]): boolean {
    return pattern.length === subject.length && pattern.every((p, i) => p === "*" || p === subject[i]);
}

/** What `sub` gets of one published event, or `SKIP`. */
function outFor(sub: Subscription, ev: Published): unknown {
    const hears = sub.spec.hears ? sub.spec.hears(sub, ev.subject) : globMatch(sub.parts, ev.subject.split("."));
    if (!hears) return SKIP;
    const data = sub.spec.deliver ? sub.spec.deliver(sub, ev.subject, ev.data) : ev.data;
    return data === undefined ? SKIP : data;
}

/**
 * Announce a change. Synchronous: every subscriber has it queued before this
 * returns, in `seq` order.
 */
export function publish(subject: string, data: unknown): void {
    const ev: Published = { seq: ++seq, subject, data };
    ring.push(ev);
    if (ring.length > REPLAY_EVENTS) ring.shift();
    for (const sub of all) {
        let out: unknown;
        try {
            out = outFor(sub, ev);
        } catch (e) {
            console.error(`[bus] delivering ${subject} to ${sub.subject} failed:`, e);
            continue;
        }
        if (out === SKIP) continue;
        sub.session.notify("bus.event", { subscription: sub.id, subject: eventSubjectFor(sub, subject, out), seq: ev.seq, data: out });
    }
}

/** The subject an event goes out under for `sub`. */
function eventSubjectFor(sub: Subscription, published: string, out: unknown): string {
    if (sub.spec.eventSubject) return sub.spec.eventSubject(sub, out);
    return sub.spec.hears ? sub.subject : published;
}

/**
 * An event for one subscription only (a row that changed with time): it takes
 * the next `seq`, and is not kept for replay.
 */
export function sendTo(sub: Subscription, data: unknown): void {
    if (!all.has(sub)) return;
    sub.session.notify("bus.event", { subscription: sub.id, subject: eventSubjectFor(sub, "", data), seq: ++seq, data });
}

/** Every live subscription to `spec`. */
export function subscriptionsOf(spec: SubjectSpec): Subscription[] {
    return [...all].filter((s) => s.spec === spec);
}

/** #3294 — the spec a subject is served by, if any. */
export function subjectSpecOf(subject: string): SubjectSpec | undefined {
    return specFor(subject.split("."))?.spec;
}

function specFor(parts: string[]): { spec: SubjectSpec; id: string } | null {
    for (const spec of specs) {
        const pat = spec.pattern.split(".");
        if (pat.length !== parts.length) continue;
        let id: string | null = null;
        let ok = true;
        for (let i = 0; i < pat.length; i++) {
            if (pat[i] === "*") id = parts[i];
            else if (pat[i] !== parts[i]) { ok = false; break; }
        }
        // #3068 — a subject may have no id (`board.events`): nothing to fill in.
        if (ok && !pat.includes("*")) return { spec, id: "" };
        if (ok && id !== null && id !== "") return { spec, id };
    }
    return null;
}

export interface SubscribeResult {
    id: string;
    subject: string;
    seq: number;
    epoch: string;
    replayed: boolean;
    value?: unknown;
    events?: { subject: string; seq: number; data: unknown }[];
}

export function subscribe(
    caller: Caller,
    subject: string,
    since: { epoch?: string; seq?: number } | undefined,
    opts: Record<string, unknown>,
): SubscribeResult {
    const session = caller.session;
    if (!session) throw new Refusal(400, "subscriptions live on a bus connection");
    const parts = subject.split(".");
    const found = specFor(parts);
    if (!found) throw new Refusal(404, `no subject ${subject}`, ERROR_CODES.NOT_FOUND);
    const { spec, id } = found;
    if (spec.machine && caller.relayed) {
        throw new Refusal(403, `${subject} is about the machine that answers: a proxy node serves it for its own machine, the core does not for a node`, ERROR_CODES.FORBIDDEN);
    }
    if (id === "*" && !spec.wildcard) throw new Refusal(400, `${spec.pattern} takes one id, not *`);
    const denied = spec.access(caller, id);
    if (denied) throw denied;
    const sub: Subscription = { id: randomUUID(), subject, parts, spec, caller, opts, state: {}, session };
    spec.setup?.(sub);
    // Registered before anything is read: nothing published after this point is missed.
    const canReplay = spec.replay !== false && since?.epoch === BUS_EPOCH && typeof since.seq === "number"
        && (since.seq >= seq || (ring.length > 0 && ring[0].seq <= since.seq + 1));
    const result: SubscribeResult = { id: sub.id, subject, seq, epoch: BUS_EPOCH, replayed: canReplay };
    if (canReplay) {
        const events: SubscribeResult["events"] = [];
        for (const ev of ring) {
            if (ev.seq <= since!.seq!) continue;
            const out = outFor(sub, ev);
            if (out !== SKIP) events.push({ subject: eventSubjectFor(sub, ev.subject, out), seq: ev.seq, data: out });
        }
        result.events = events;
    } else {
        result.value = spec.value(sub);
    }
    session.subscriptions.set(sub.id, sub);
    all.add(sub);
    return result;
}

export function unsubscribe(caller: Caller, id: string): boolean {
    const sub = caller.session?.subscriptions.get(id);
    if (!sub) return false;
    caller.session!.subscriptions.delete(id);
    all.delete(sub);
    sub.spec.release?.(sub);
    return true;
}

/** The connection closed: its subscriptions go with it. */
export function dropSession(session: BusSession): void {
    for (const sub of session.subscriptions.values()) {
        all.delete(sub);
        sub.spec.release?.(sub);
    }
    session.subscriptions.clear();
}

/** Tests only: how many subscriptions are live. */
export function subscriptionCountForTests(): number {
    return all.size;
}
