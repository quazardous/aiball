/**
 * #2770 — the critical ticket: the open ticket holding back the most open
 * tickets, down the whole chain, at least two, a tie going to the quietest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateEdges, pickCritical, quietFor, type GateEdge } from "./critical-ticket.js";

const rel = (on: number, target: number, kind: string) => ({
    sourceTicketId: on,
    targetTicketId: target,
    meta: JSON.stringify({ relation: { kind, target_ticket_id: target } }),
});

test("gateEdges reads depends_on and blocks as who waits on whom, the latest event of a pair winning", () => {
    const edges = gateEdges([
        rel(1, 2, "depends_on"), // 1 waits on 2
        rel(3, 4, "blocks"), // 4 waits on 3
        rel(5, 6, "depends_on"),
        rel(5, 6, "ignored"), // unrelated since
        rel(7, 8, "relates_to"),
    ]);
    assert.deepEqual(edges, [{ waiter: 1, blocker: 2 }, { waiter: 4, blocker: 3 }]);
});

const all = () => true;
const never = () => 0;

test("a ticket holds everything down its chain, not only what waits on it directly", () => {
    // 1 and 2 wait on 10; 3 waits on 1: 10 holds 1, 2 and 3.
    const edges: GateEdge[] = [{ waiter: 1, blocker: 10 }, { waiter: 2, blocker: 10 }, { waiter: 3, blocker: 1 }];
    assert.deepEqual(pickCritical(edges, all, all, never), { id: 10, holds: 3 });
});

test("holding a single ticket is ordinary sequencing: no critical ticket", () => {
    assert.equal(pickCritical([{ waiter: 1, blocker: 10 }], all, all, never), null);
});

test("closed tickets neither hold nor are held", () => {
    const edges: GateEdge[] = [{ waiter: 1, blocker: 10 }, { waiter: 2, blocker: 10 }, { waiter: 3, blocker: 11 }, { waiter: 4, blocker: 11 }];
    const open = (id: number) => id !== 2 && id !== 11;
    assert.equal(pickCritical(edges, open, all, never), null, "10 holds only 1 once 2 is closed, 11 is closed");
});

test("only the project's tickets are candidates; what they hold may be anywhere", () => {
    const edges: GateEdge[] = [{ waiter: 1, blocker: 10 }, { waiter: 2, blocker: 10 }, { waiter: 3, blocker: 20 }, { waiter: 4, blocker: 20 }, { waiter: 5, blocker: 20 }];
    assert.deepEqual(pickCritical(edges, all, (id) => id === 10, never), { id: 10, holds: 2 });
});

test("a tie goes to the ticket that has not moved for longest", () => {
    const edges: GateEdge[] = [{ waiter: 1, blocker: 10 }, { waiter: 2, blocker: 10 }, { waiter: 3, blocker: 20 }, { waiter: 4, blocker: 20 }];
    const moved = (id: number) => (id === 20 ? 1_000 : 5_000);
    assert.equal(pickCritical(edges, all, all, moved)?.id, 20);
});

test("a cycle terminates and does not count the ticket itself", () => {
    const edges: GateEdge[] = [{ waiter: 1, blocker: 10 }, { waiter: 10, blocker: 1 }, { waiter: 2, blocker: 10 }];
    assert.deepEqual(pickCritical(edges, all, (id) => id === 10, never), { id: 10, holds: 2 });
});

test("quiet shows once a full day has passed, in days", () => {
    const now = Date.parse("2026-09-18T12:00:00Z");
    assert.equal(quietFor(now - 23 * 3_600_000, now), "");
    assert.equal(quietFor(now - 3 * 86_400_000 - 60_000, now), "3 d");
});
