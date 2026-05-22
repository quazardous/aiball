/**
 * Notification service (#260/#261, david 3uh7zc: "donne les clés de la
 * responsabilité à un service unique, étage-le au-dessus de la db").
 *
 * Single owner of the "who learns about which message event" policy,
 * layered directly above the ping primitives in `db/pings.ts`
 * (insertPing/emitPing) and below the orchestration/route layers
 * (`messages.ts`, `api/*`). Every ping the system emits flows through one
 * of these functions — no caller reaches into `insertPing` directly:
 *
 *   - fanOutPings(msg)          — subscriber/owner/follower + moderator fan-out
 *   - fanOutMentions(msg)       — forced @<name> delivery
 *   - notifyDecision(msg, by?)  — ping the AUTHOR of a message when a
 *       decision lands on it (moderation approve/reject, or
 *       decision-on-comment accept/reject). Before this existed, the
 *       decision-on-comment `decide` path notified no one — accepting a
 *       plan didn't wake the agent to execute (#260) and rejecting didn't
 *       hand the ticket back (#261).
 */
import {
    insertPing,
    isHuman,
    listHumans,
    listProjects,
    listProjectSubscribers,
    listTicketSubscribers,
    mutedConsumersForTicket,
    type Message,
} from "./db.js";

/**
 * Extract `@<name>` mentions from a body. Code fences / inline-code spans
 * are stripped first so refs inside them don't fire. Names accept word
 * chars, dash and underscore, 2..64 long. Self-mentions (the author's own
 * consumer_id) are skipped.
 */
function extractMentions(
    body: string | null | undefined,
    selfAgent: string | null,
): string[] {
    if (!body) return [];
    const stripped = body
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "");
    const out = new Set<string>();
    // Boundary: start of input or a non-word non-`@` char (so `email@x`
    // and `@@name` don't get caught).
    const re = /(?:^|[^\w@])@([a-zA-Z0-9_-]{2,64})\b/g;
    for (const m of stripped.matchAll(re)) {
        const name = m[1];
        if (selfAgent && name === selfAgent) continue;
        out.add(name);
    }
    return [...out];
}

/**
 * Fan out delivery rows (in the `pings` table) for every recipient that
 * should learn about this newly-approved message. Recipients are the union
 * of:
 *   - ticket subscribers (people following the thread directly — they always
 *     get pings on threads they explicitly follow, regardless of broadcast).
 *   - project owners (subscriptions.role = "owner" — agents that maintain
 *     this project, they want to see every movement, internal or not).
 *   - project followers (subscriptions.role = "follower"), but only when
 *     the message scope is `broadcast`. This keeps internal dev chatter out
 *     of external agents' inboxes while still letting public/API-impacting
 *     tickets reach them.
 * minus the message author themself (no self-ping).
 *
 * Each ping row is per-recipient with its own `seen_at`, so consumption is
 * independent across consumers. Called only when a message becomes approved.
 *
 * This is the SOLE delivery mechanism — there is no cursor model anywhere.
 * Pending-then-approved messages always reach every interested consumer
 * because the fan-out runs at approval time, not at submission.
 */
export function fanOutPings(msg: Message): void {
    // #B.245 tristate: `internal` events skip subscriber fan-out
    // entirely — only @mentions reach (via fanOutMentions, called
    // separately at submit time). Moderators still see the row in
    // the pending queue if it's not auto-approved; they just don't
    // get a personal ping for it.
    if (msg.scope === "internal") return;

    const recipients = new Set<string>();

    // Ticket subscribers: explicit thread follow always wins regardless of
    // event scope (above the per-event broadcast gate). Skip on
    // ticket_created since there's no thread yet (the creator is
    // auto-subbed to their own ticket and self-filtered).
    if (msg.kind !== "ticket_created" && msg.ticket_id !== null) {
        for (const sub of listTicketSubscribers(msg.ticket_id)) {
            recipients.add(sub);
        }
    }

    // Project owners always see `default` and `broadcast` events.
    for (const sub of listProjectSubscribers(msg.project, { roles: ["owner"] })) {
        recipients.add(sub);
    }

    // Project followers only see `broadcast`-scoped events — per-event
    // decision now (post-#B.245), no longer derived from the ticket-wide
    // flag. The previous ticket-level `broadcast` boolean was unified
    // into this same tristate; each event decides its own follower reach.
    if (msg.scope === "broadcast") {
        for (const sub of listProjectSubscribers(msg.project, { roles: ["follower"] })) {
            recipients.add(sub);
        }
    }

    // Pending messages also ping every registered human moderator (#B.79)
    // so they show up as unread in the moderation queue even when not
    // subscribed to the project. Approved messages don't need this —
    // the regular subscriber fan-out already covers what humans care
    // about.
    if (msg.status === "pending") {
        for (const h of listHumans()) recipients.add(h);
    }

    // #352: explicit mutes beat role + subscription. Remove anyone who muted
    // this ticket — the only way a project owner (pinged by role above) can
    // silence a single thread. Applied last so it overrides every add path.
    if (msg.ticket_id !== null) {
        for (const m of mutedConsumersForTicket(msg.ticket_id)) recipients.delete(m);
    }

    const authorIsHuman = msg.by_agent != null && isHuman(msg.by_agent);
    // #B.191: when a human posts, skip pings to other humans — they
    // share the moderator backlog, so cross-human pings are noise.
    // Hoist the human set so we don't SELECT once per recipient.
    const humanSet = authorIsHuman ? new Set(listHumans()) : null;
    for (const r of recipients) {
        if (r === msg.by_agent) continue;
        if (humanSet?.has(r)) continue;
        // #296: actor = the post author who triggered this fan-out.
        insertPing(r, msg, msg.by_agent);
    }
}

/**
 * Force-deliver pings to `@<name>` mentions in the body (per #B.71).
 * Disambiguation:
 *   - `@<name>` matching a known project → ping every owner+follower of
 *     that project (broadcast-style, but limited to the project membership).
 *   - Otherwise → ping the consumer named directly, even if not subscribed
 *     to anything (forced one-shot delivery).
 *
 * Self-mention is filtered. Existing pings (from the normal subscriber
 * fan-out) dedup naturally via insertPing's onConflictDoNothing.
 */
export function fanOutMentions(msg: Message): void {
    const mentions = extractMentions(msg.body, msg.by_agent);
    if (mentions.length === 0) return;
    const knownProjects = new Set(listProjects());
    // #B.245 tristate: at `internal` scope, @projet narrows to owners
    // only (the whole point of the narrow scope — keep dev chatter
    // off followers' inboxes). `default` and `broadcast` keep the
    // wide owner+follower reach for @projet. @agent mentions are
    // unaffected — they target a single consumer regardless of scope.
    const projectRoles: ("owner" | "follower")[] = msg.scope === "internal"
        ? ["owner"]
        : ["owner", "follower"];
    for (const name of mentions) {
        if (knownProjects.has(name)) {
            const subs = listProjectSubscribers(name, { roles: projectRoles });
            for (const sub of subs) {
                if (sub === msg.by_agent) continue;
                insertPing(sub, msg, msg.by_agent);
            }
        } else {
            // Treated as a consumer_id. We forcibly insert a ping even if
            // the recipient isn't subscribed to anything — that's the
            // whole point of the @-mention feature.
            insertPing(name, msg, msg.by_agent);
        }
    }
}

/**
 * Ping the AUTHOR of a message when a decision lands on it. One owner for
 * both decision flows:
 *   - moderation approve/reject (`POST /messages/:id/(approve|reject)`)
 *   - decision-on-comment accept/reject (`POST /messages/:id/decide`)
 *
 * The decision-on-comment path previously notified no one, so accepting a
 * plan (the go-signal) didn't wake the agent to execute (#260) and a reject
 * didn't surface the ticket back in the agent's court (#261). Routing both
 * through here closes that gap and removes the ad-hoc `insertPing` the API
 * layer used to hand-roll.
 *
 * Skips human authors (they share the moderator backlog, same rationale as
 * fanOutPings #B.191) and the decider themselves (`decidedBy`) so a
 * self-accept doesn't self-ping. `insertPing` dedups via its PK, so a ping
 * already delivered by the normal fan-out is a safe no-op.
 */
export function notifyDecision(msg: Message, decidedBy?: string | null): void {
    if (!msg.by_agent) return;
    if (isHuman(msg.by_agent)) return;
    if (decidedBy && msg.by_agent === decidedBy) return;
    // #296: actor = the decider (NOT the author). The ping targets the
    // author about their own comment, but since actor != recipient it is no
    // longer treated as a self-ping → it surfaces and wakes the agent.
    insertPing(msg.by_agent, msg, decidedBy ?? null);
}
