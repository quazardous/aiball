/*
 * The counters, read on the bus: what a frame from the daemon is, which board
 * events move the numbers, and when to read them again.
 *
 * Import-free on purpose, like the other *State.js modules: the rules are
 * pinned by tests that run without a GNOME Shell.
 *
 * Why events rather than a poll: the counters cost 150-220 ms on a real board,
 * served one caller at a time. Subscribed to the board's events, the indicator
 * reads them again only when something that moves them happened — and a burst
 * of events (an agent posting a batch) costs one read, not one per event.
 */

/** The bus's path on the daemon's socket. */
export const BUS_PATH = '/bus';

/**
 * The events that can change a counter: a message (a ticket filed, decided,
 * moderated), a consumer (a loop coming or going), a project renamed or gone.
 * `agent_bar` fires on every loop's status bar and moves none of them.
 */
const COUNTER_EVENTS = new Set([
    'message_created', 'message_decided', 'message_edited', 'message_noted',
    'consumer_changed', 'project_deleted', 'project_purged', 'project_renamed',
]);

/** A board event `{ type, data }` that may have moved a counter. */
export function movesCounters(event) {
    return !!event && COUNTER_EVENTS.has(event.type);
}

/** A call, as the frame to send. */
export function request(id, method, params = {}) {
    return JSON.stringify({jsonrpc: '2.0', id, method, params});
}

/**
 * What a frame from the daemon is:
 *   { kind: 'hello' }                          the daemon is ready for calls
 *   { kind: 'reply', id, result } / { kind: 'reply', id, error }
 *   { kind: 'event', subscription, data }     a subscription's event
 *   { kind: 'other' }                          anything else, ignored
 */
export function classify(text) {
    let msg;
    try {
        msg = JSON.parse(text);
    } catch {
        return {kind: 'other'};
    }
    if (!msg || typeof msg !== 'object') return {kind: 'other'};
    if (msg.method === 'bus.hello') return {kind: 'hello'};
    if (msg.method === 'bus.event' && msg.params)
        return {kind: 'event', subscription: msg.params.subscription, data: msg.params.data};
    if (typeof msg.id === 'number') {
        if (msg.error) return {kind: 'reply', id: msg.id, error: msg.error.message ?? 'refused'};
        return {kind: 'reply', id: msg.id, result: msg.result};
    }
    return {kind: 'other'};
}

/** The menu's numbers, summed across projects; null for anything but a list. */
export function sumCounts(projects) {
    if (!Array.isArray(projects)) return null;
    let pending = 0, actionable = 0, open = 0, loops = 0;
    for (const p of projects) {
        pending += p.pending_count ?? 0;
        actionable += p.actionable_count ?? 0;
        open += p.open_count ?? 0;
        if (p.running) loops += 1;
    }
    return {pending, actionable, open, loops};
}

/** Wait this long after an event: the rest of a burst lands meanwhile. */
export const SETTLE_MS = 2000;
/** And never read more often than this, however busy the board. */
export const MIN_SPACING_MS = 10000;
/**
 * Subscribed, read again anyway when nothing did for this long: some numbers
 * move with time alone (a postponed ticket coming back), and no event says so.
 */
export const QUIET_REFRESH_MS = 5 * 60 * 1000;

/**
 * When to read the counters after an event, in ms from `now`; null when a read
 * is already due (it will see this event too). `lastReadAt` is when the last
 * read started, or null for none yet.
 */
export function refreshDelay(now, lastReadAt, due) {
    if (due) return null;
    const settle = now + SETTLE_MS;
    const spaced = lastReadAt === null ? settle : lastReadAt + MIN_SPACING_MS;
    return Math.max(settle, spaced) - now;
}

/**
 * Whether the periodic tick should read the counters: always without a
 * subscription (nothing else would), and with one only after a quiet spell.
 */
export function tickReads(now, lastReadAt, subscribed) {
    if (!subscribed || lastReadAt === null) return true;
    return now - lastReadAt >= QUIET_REFRESH_MS;
}
