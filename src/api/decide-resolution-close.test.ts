// #980 david `7cnyjb` — accepting a `resolution` decision on a comment must
// auto-close the ticket from the SAME /decide call, with the close emitted
// `skipFanOut` so the accept produces ONE ping (the `resolution_accepted`
// decision-event), not two (the old front POSTed a separate `ticket_closed`
// whose fan-out was the 2nd ping, cf. #965/#972). Mirrors the existing
// wontfix auto-close (#802). Spawns the real app on an ephemeral port.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

const home = mkdtempSync(join(tmpdir(), "aiball-980-"));
process.env.AIBALL_HOME = home;

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { ensureConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { updateMessageStatus } = await import("../db/messages.js");
const { createProject } = await import("../db/projects.js");
const { attachWs } = await import("../ws.js");
const schema = await import("../schema.js");
const { eq, and } = await import("drizzle-orm");

const REP = "decide-rep";   // reporter — accepts the decision
const AG = "decide-agent";  // proposal author — receives the accept ping
ensureConsumer(REP);
ensureConsumer(AG);
const TOKEN_REP = issueToken({ kind: "agent", consumer_id: REP, label: "980-rep" }).token;

const server = createApp().listen(0);
attachWs(server); // wire /ws so the broadcast-suppression test can observe events
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

after(() => {
    server.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const db = getDb();
createProject({ name: "p-980" });

/** Seed a ticket (reporter REP) + a comment by AG carrying a pending decision
 *  of the given kind. Goes through submitMessage so the ticket is a real
 *  `ticket_created` message — required for the close-authority check
 *  (`assertCloseAuthority` matches by_agent against the ticket reporter).
 *  Returns {tid, commentId}. */
function seed(kind: "resolution" | "wontfix" | "plan"): { tid: number; commentId: number } {
    const t = submitMessage({
        project: "p-980",
        kind: "ticket_created",
        title: "T",
        body: "x",
        by_agent: REP,
    });
    if (t.status !== "approved") {
        updateMessageStatus(t.id, "approved", "human", null, "ticket_created");
    }
    const c = submitMessage({
        project: "p-980",
        kind: "comment_added",
        ticket_id: t.id,
        body: "proposal body",
        by_agent: AG,
        decision_kind: kind,
        summary_until: "proposed",
    });
    return { tid: t.id, commentId: c.id };
}

async function decide(commentId: number, status: "accepted" | "rejected", closeBody?: string): Promise<number> {
    const r = await fetch(`${BASE}/api/messages/${commentId}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_REP}` },
        body: JSON.stringify({ status, ...(closeBody ? { body: closeBody } : {}) }),
    });
    return r.status;
}

/** Count pings to a recipient across every message on a ticket. */
function pingsToOnTicket(tid: number, recipient: string): number {
    const msgIds = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, tid))
        .all()
        .map((m) => m.id);
    if (msgIds.length === 0) return 0;
    return db.select({ commentId: schema.pings.commentId, recipient: schema.pings.recipient })
        .from(schema.pings)
        .all()
        .filter((p) => p.recipient === recipient && p.commentId != null && msgIds.includes(p.commentId))
        .length;
}

function closeEvents(tid: number) {
    return db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(and(eq(schema.messages.ticketId, tid), eq(schema.messages.kind, "ticket_closed")))
        .all();
}

function metaStatus(commentId: number): string | undefined {
    const m = db.select({ meta: schema.messages.meta })
        .from(schema.messages)
        .where(eq(schema.messages.id, commentId))
        .get();
    if (!m?.meta) return undefined;
    try { return (JSON.parse(m.meta) as { decision?: { status?: string } }).decision?.status; }
    catch { return undefined; }
}

test("#980: resolution accept auto-closes + resolves with exactly ONE ping", async () => {
    const { tid, commentId } = seed("resolution");
    assert.equal(await decide(commentId, "accepted"), 200);

    // resolved (derived from accepted meta) + closed (auto-close event).
    assert.equal(metaStatus(commentId), "accepted", "resolution meta flipped to accepted");
    const closes = closeEvents(tid);
    assert.equal(closes.length, 1, "exactly one ticket_closed auto-emitted");

    // The whole accept produces ONE ping to the proposal author, not two.
    assert.equal(pingsToOnTicket(tid, AG), 1, "single accept ping (no separate close ping)");
    // And the close event itself fanned out to nobody (skipFanOut).
    assert.equal(
        db.select({ r: schema.pings.recipient }).from(schema.pings)
            .where(eq(schema.pings.commentId, closes[0].id)).all().length,
        0,
        "ticket_closed produced no ping (skipFanOut)",
    );
});

test("#980: resolution accept with a note carries it on the close event", async () => {
    const { tid, commentId } = seed("resolution");
    assert.equal(await decide(commentId, "accepted", "shipped in abc123"), 200);
    const closes = closeEvents(tid);
    assert.equal(closes.length, 1);
    const closeMsg = db.select({ body: schema.messages.body })
        .from(schema.messages).where(eq(schema.messages.id, closes[0].id)).get();
    assert.equal(closeMsg?.body, "shipped in abc123", "note rode on the close event");
});

test("#980 matrix: resolution REJECT does not close the ticket", async () => {
    const { tid, commentId } = seed("resolution");
    assert.equal(await decide(commentId, "rejected"), 200);
    assert.equal(metaStatus(commentId), "rejected");
    assert.equal(closeEvents(tid).length, 0, "reject must not auto-close");
});

test("#980 matrix: plan accept does not close the ticket", async () => {
    const { tid, commentId } = seed("plan");
    assert.equal(await decide(commentId, "accepted"), 200);
    assert.equal(closeEvents(tid).length, 0, "plan accept is a go-signal, not a close");
});

test("#980: wontfix accept still auto-closes (regression guard)", async () => {
    const { tid, commentId } = seed("wontfix");
    assert.equal(await decide(commentId, "accepted"), 200);
    assert.equal(closeEvents(tid).length, 1, "wontfix auto-close preserved");
});

test("#980 N2: auto-close ticket_closed does NOT broadcast (single toaster/counter)", async () => {
    const { commentId } = seed("resolution");
    const events: Array<{ type: string; kind?: string }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
    });
    ws.on("message", (raw: Buffer) => {
        try {
            const m = JSON.parse(raw.toString()) as { type: string; data?: { kind?: string } };
            events.push({ type: m.type, kind: m.data?.kind });
        } catch { /* hello / non-JSON */ }
    });

    assert.equal(await decide(commentId, "accepted"), 200);
    await new Promise((r) => setTimeout(r, 300)); // let broadcasts flush
    ws.close();

    // The auto-close ticket_closed must be SILENT (skipBroadcast) — no
    // message_created / message_decided carrying kind=ticket_closed.
    assert.equal(
        events.filter((e) => e.kind === "ticket_closed").length,
        0,
        "auto-close must not broadcast (else the toaster + e: counter double)",
    );
    // …while the resolution_accepted decision event IS the single notification.
    assert.ok(
        events.some((e) => e.kind === "resolution_accepted"),
        "resolution_accepted must broadcast (the one user-facing notification)",
    );
});
