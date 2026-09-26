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
     * false: a `since` always gets the value again. For a view whose rows the
     * spec keeps per subscription, events replayed on the current rows could
     * leave behind one that left the view while the client was away.
     */
    replay?: boolean;
    access(caller: Caller, id: string): Refusal | null;
    /** The current value, for one id or (`*`) all of them as `id → value`. */
    value(sub: Subscription): unknown;
    /** Which published subjects this subscription hears; by default its own. */
    hears?(sub: Subscription, subject: string): boolean;
    /** What the subscriber receives of an event, or null for nothing. */
    deliver?(sub: Subscription, subject: string, data: unknown): unknown;
    /** Called once the subscription is gone (a source to let go of). */
    release?(sub: Subscription): void;
    /** The concrete subject an event goes out under, when it hears wider (`hears`). */
    eventSubject?(sub: Subscription, out: unknown): string;
}

const specs: SubjectSpec[] = [];

export function defineSubject(spec: SubjectSpec): void {
    specs.push(spec);
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

/** What `sub` gets of one published event, or null. */
function outFor(sub: Subscription, ev: Published): unknown {
    const hears = sub.spec.hears ? sub.spec.hears(sub, ev.subject) : globMatch(sub.parts, ev.subject.split("."));
    if (!hears) return null;
    const data = sub.spec.deliver ? sub.spec.deliver(sub, ev.subject, ev.data) : ev.data;
    return data === null || data === undefined ? null : data;
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
        if (out === null) continue;
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
    if (id === "*" && !spec.wildcard) throw new Refusal(400, `${spec.pattern} takes one id, not *`);
    const denied = spec.access(caller, id);
    if (denied) throw denied;
    const sub: Subscription = { id: randomUUID(), subject, parts, spec, caller, opts, state: {}, session };
    // Registered before anything is read: nothing published after this point is missed.
    const canReplay = spec.replay !== false && since?.epoch === BUS_EPOCH && typeof since.seq === "number"
        && (since.seq >= seq || (ring.length > 0 && ring[0].seq <= since.seq + 1));
    const result: SubscribeResult = { id: sub.id, subject, seq, epoch: BUS_EPOCH, replayed: canReplay };
    if (canReplay) {
        const events: SubscribeResult["events"] = [];
        for (const ev of ring) {
            if (ev.seq <= since!.seq!) continue;
            const out = outFor(sub, ev);
            if (out !== null) events.push({ subject: eventSubjectFor(sub, ev.subject, out), seq: ev.seq, data: out });
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
