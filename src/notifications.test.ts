// #752 — owner-branch gate by `can_claim` (mirrors the follower gate of
// #516). A `no_claim` owner drops out of the default/broadcast fan-out so
// accessory relay nodes (graphite/aiball-win) stop receiving the firehose
// on tickets they neither authored, are subscribed to, nor were mentioned
// in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-752-"));

const { getDb, nowIso } = await import("./db/connection.js");
const schema = await import("./schema.js");
const { upsertConsumer, updateConsumer } = await import("./db/consumers.js");
const { upsertSubscription } = await import("./db/subscriptions.js");
const { fanOutPings } = await import("./notifications.js");
const { eq } = await import("drizzle-orm");

const PROJECT = "p-752";
let _seq = 0;

function seedConsumer(id: string, opts: { can_claim?: boolean; notify_pb?: boolean | null } = {}): void {
    upsertConsumer({ consumer_id: id, kind: "agent" });
    if (opts.can_claim !== undefined || opts.notify_pb !== undefined) {
        updateConsumer(id, {
            can_claim: opts.can_claim,
            notify_project_broadcasts: opts.notify_pb,
        });
    }
}

function seedComment(by: string, ticket_id: number, scope: "internal" | "default" | "broadcast" = "default"): {
    id: number;
    project: string;
    kind: "comment_added";
    ticket_id: number;
    parent_id: number;
    title: null;
    body: string;
    by_agent: string;
    status: "approved";
    created_at: string;
    decided_at: string;
    decided_by: "auto";
    matched_rule_id: null;
    human_note: null;
    original_title: null;
    original_body: null;
    intent: null;
    display_seq: number;
    scope: "internal" | "default" | "broadcast";
    hashid: null;
    source_ticket_id: null;
    meta: null;
} {
    const db = getDb();
    const now = nowIso();
    const r = db.insert(schema.messages).values({
        kind: "comment_added",
        ticketId: ticket_id,
        body: "x",
        byAgent: by,
        status: "approved",
        createdAt: now,
        decidedAt: now,
        decidedBy: "auto",
        displaySeq: ++_seq,
        scope,
    }).returning().get();
    // `messages` is keyed by ticketId — `project` is derived from the
    // ticket and joined back in for the fan-out call.
    return {
        id: r.id,
        project: PROJECT,
        kind: "comment_added",
        ticket_id: r.ticketId!,
        parent_id: ticket_id,
        title: null,
        body: r.body!,
        by_agent: r.byAgent!,
        status: "approved",
        created_at: r.createdAt,
        decided_at: r.decidedAt!,
        decided_by: "auto",
        matched_rule_id: null,
        human_note: null,
        original_title: null,
        original_body: null,
        intent: null,
        display_seq: r.displaySeq!,
        scope,
        hashid: null,
        source_ticket_id: null,
        meta: null,
    };
}

function pingedRecipients(comment_id: number): Set<string> {
    const db = getDb();
    const rows = db.select({ r: schema.pings.recipient })
        .from(schema.pings)
        .where(eq(schema.pings.commentId, comment_id))
        .all();
    return new Set(rows.map((r) => r.r));
}

// Seed the project + a ticket once.
const db = getDb();
db.insert(schema.tickets).values({
    id: 1,
    project: PROJECT,
    displaySeq: 1,
    title: "T1",
    status: "approved",
    createdAt: nowIso(),
}).run();

test("#752: a no_claim owner (can_claim=false) is excluded from default fan-out", () => {
    seedConsumer("alice", { can_claim: true });
    seedConsumer("accessory", { can_claim: false });
    seedConsumer("author", { can_claim: true });
    upsertSubscription("alice", PROJECT, "owner");
    upsertSubscription("accessory", PROJECT, "owner");
    upsertSubscription("author", PROJECT, "owner");

    const msg = seedComment("author", 1, "default");
    fanOutPings(msg as never);

    const recipients = pingedRecipients(msg.id);
    assert.ok(recipients.has("alice"), "claim-able owner gets the ping");
    assert.ok(!recipients.has("accessory"), "no_claim owner is excluded (the #752 fix)");
    assert.ok(!recipients.has("author"), "the author never pings themselves");
});

test("#752: explicit notify_project_broadcasts=true overrides can_claim=false", () => {
    seedConsumer("bob", { can_claim: false, notify_pb: true });
    upsertSubscription("bob", PROJECT, "owner");

    const msg = seedComment("alice", 1, "default");
    fanOutPings(msg as never);

    const recipients = pingedRecipients(msg.id);
    assert.ok(recipients.has("bob"), "explicit notify_pb=true wins over can_claim=false");
});

test("#752: explicit notify_project_broadcasts=false silences a claim-able owner", () => {
    seedConsumer("carol", { can_claim: true, notify_pb: false });
    upsertSubscription("carol", PROJECT, "owner");

    const msg = seedComment("alice", 1, "default");
    fanOutPings(msg as never);

    const recipients = pingedRecipients(msg.id);
    assert.ok(!recipients.has("carol"), "explicit notify_pb=false beats can_claim=true");
});
