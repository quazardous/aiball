/**
 * #3251 — a ticket's state says the same on every surface: ticket.get's header,
 * the inbox's aggregate, closedTicketIds and the search's open filter, for
 * tickets with varied histories.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3251-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { upsertSubscription } = await import("./subscriptions.js");
const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");
const { closedTicketIds } = await import("./ticket-closed.js");
const { getInboxAgg, invalidateInboxAgg } = await import("./inbox-agg.js");
const { searchMessages } = await import("../search.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "states" });
upsertSubscription("worker", "states", "owner");
const boss = testCaller("boss", { kind: "human" });
const worker = testCaller("worker");
const call = (c: typeof boss, m: string, p: Record<string, unknown>) => getMethod(m)!.run(c, p) as Promise<Record<string, unknown>>;

async function ticket(title: string): Promise<number> {
    const t = await call(boss, "message.post", { kind: "ticket_created", project: "states", title, body: "b" });
    return t.id as number;
}
const post = (c: typeof boss, ticketId: number, extra: Record<string, unknown>) =>
    call(c, "message.post", { kind: "comment_added", project: "states", ticket_id: ticketId, body: "x", summary_until: "s", commits: null, ...extra });
const lifecycle = (kind: string, ticketId: number) => call(boss, "message.post", { kind, project: "states", ticket_id: ticketId, body: "" });

test("each history reads the same on ticket.get, the inbox, closedTicketIds and the search", async () => {
    const open = await ticket("zz open");
    const closed = await ticket("zz closed");
    await lifecycle("ticket_closed", closed);
    const reopened = await ticket("zz reopened");
    await lifecycle("ticket_closed", reopened);
    await lifecycle("ticket_reopened", reopened);
    const planned = await ticket("zz planned");
    await post(worker, planned, { decision_kind: "plan" });
    const replaced = await ticket("zz replaced");
    await post(worker, replaced, { decision_kind: "plan" });
    const newer = await post(worker, replaced, { decision_kind: "plan" });
    const resolved = await ticket("zz resolved");
    const res = await post(worker, resolved, { decision_kind: "resolution" });
    await call(boss, "message.decide", { id: res.id, status: "accepted" });
    const reopenedAfterResolve = await ticket("zz resolved then reopened");
    const res2 = await post(worker, reopenedAfterResolve, { decision_kind: "resolution" });
    await call(boss, "message.decide", { id: res2.id, status: "accepted" });
    await lifecycle("ticket_closed", reopenedAfterResolve);
    await lifecycle("ticket_reopened", reopenedAfterResolve);

    const ids = [open, closed, reopened, planned, replaced, resolved, reopenedAfterResolve];
    const closedSet = closedTicketIds(ids);
    invalidateInboxAgg();
    const agg = getInboxAgg("states");
    const openHits = new Set(searchMessages("zz", { open: true, project: "states" } as never).filter((h) => h.kind === "ticket").map((h) => h.id));
    for (const id of ids) {
        const got = await call(boss, "ticket.get", { id }) as { ticket?: Record<string, unknown> } & Record<string, unknown>;
        const h = (got.ticket ?? got) as { closed: boolean; resolved: boolean; resolved_by: string | null };
        // A ticket nothing happened on has no aggregate: the inbox reads it as open.
        const a = agg.get(id);
        assert.equal(h.closed, closedSet.has(id), `#${id}: ticket.get vs closedTicketIds`);
        assert.equal(a?.closed ?? false, h.closed, `#${id}: inbox vs ticket.get (closed)`);
        assert.equal(a?.resolved ?? false, h.resolved, `#${id}: inbox vs ticket.get (resolved)`);
        assert.equal(openHits.has(id), !h.closed, `#${id}: search's open filter`);
    }
    const header = async (id: number) => {
        const got = await call(boss, "ticket.get", { id }) as { ticket?: Record<string, unknown> } & Record<string, unknown>;
        return (got.ticket ?? got) as { closed: boolean; resolved: boolean; resolved_by: string | null; latest_decision: { message_id: number; kind: string; status: string } | null };
    };
    assert.equal((await header(closed)).closed, true);
    assert.equal((await header(reopened)).closed, false, "a reopen clears the close");
    assert.equal((await header(resolved)).resolved, true);
    assert.equal((await header(resolved)).resolved_by, "boss", "dated and signed by its decision");
    assert.equal((await header(reopenedAfterResolve)).resolved, false, "a reopen clears the resolution");
    const plan = (await header(planned)).latest_decision;
    assert.deepEqual(plan && { kind: plan.kind, status: plan.status }, { kind: "plan", status: "pending" });
    assert.equal((await header(replaced)).latest_decision?.message_id, newer.id, "the newer plan is the latest");
    assert.equal((await header(open)).latest_decision, null);
});
