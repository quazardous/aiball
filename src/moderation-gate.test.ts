/**
 * #3249 — "the ticket must be approved first", one rule for proposing,
 * deciding and claiming, and the flag a reader checks before proposing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moderationRefusal } from "./moderation-gate.js";

const home = mkdtempSync(join(tmpdir(), "aiball-3249-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const pending = { status: "pending" };

test("approved: nothing is refused, to anyone", () => {
    for (const action of ["propose", "decide", "claim"] as const) {
        assert.equal(moderationRefusal(action, { status: "approved" }, { human: false }), null, action);
    }
});

test("pending: an agent may neither propose, decide nor claim; the code says why", () => {
    for (const action of ["propose", "decide", "claim"] as const) {
        assert.equal(moderationRefusal(action, pending, { human: false, decisionKind: "resolution" })?.code, "PARENT_PENDING_MODERATION", action);
    }
});

test("the exemptions: a human proposes and claims, never decides before approving; a plan amends a waiting one", () => {
    assert.equal(moderationRefusal("propose", pending, { human: true }), null);
    assert.equal(moderationRefusal("claim", pending, { human: true }), null);
    assert.notEqual(moderationRefusal("decide", pending, { human: true }), null, "the moderator approves, then decides");
    assert.equal(moderationRefusal("propose", pending, { human: false, decisionKind: "plan", pendingPlan: () => true }), null);
    assert.notEqual(moderationRefusal("propose", pending, { human: false, decisionKind: "resolution", pendingPlan: () => true }), null, "only a plan amends");
});

test("ticket.get: decision_proposable follows the gate for its reader", async () => {
    const { upsertConsumer } = await import("./db.js");
    const { submitMessage } = await import("./messages.js");
    const { getMethod } = await import("./bus/methods.js");
    await import("./bus/register.js");
    const { testCaller } = await import("./tests/lib.js");
    upsertConsumer({ consumer_id: "boss", kind: "human" });
    upsertConsumer({ consumer_id: "worker", kind: "agent" });
    const { createProject } = await import("./db/projects.js");
    createProject({ name: "gate" });
    const t = submitMessage({ project: "gate", kind: "ticket_created", title: "pending", body: "b", by_agent: "worker" });
    assert.equal(t.status, "pending", "an agent's ticket waits for moderation here");
    const get = getMethod("ticket.get")!;
    type Got = { decision_proposable?: boolean; ticket?: { decision_proposable: boolean } };
    const flag = (g: Got) => g.ticket?.decision_proposable ?? g.decision_proposable;
    const asAgent = flag(await get.run(testCaller("worker"), { id: t.id }) as Got);
    const asHuman = flag(await get.run(testCaller("boss", { kind: "human" }), { id: t.id }) as Got);
    assert.equal(asAgent, false);
    assert.equal(asHuman, true, "a human may propose on a pending ticket: the flag no longer says no");
});
