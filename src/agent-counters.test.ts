// #3272 — counters are recomputed for the agents someone reads them for (a listening loop, a present agent), not for every agent a change concerns.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { until } from "./tests/lib.js";

const home = mkdtempSync(join(tmpdir(), "aiball-3272-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.AIBALL_COUNTERS_GAP_MS = "0";
const { upsertConsumer } = await import("./db.js");
const { getDb } = await import("./db/connection.js");
const { cachedCounters, markCountersDirty, onCounters, resetCountersForTests } = await import("./agent-counters.js");
const { presenceConnect, __resetPresence } = await import("./live-presence.js");
after(() => { resetCountersForTests(); __resetPresence(); rmSync(home, { recursive: true, force: true }); });

getDb();
for (const id of ["present", "listened", "absent"]) upsertConsumer({ consumer_id: id, kind: "agent" });

test("a change recomputes a present agent's and a listened-to agent's counters, never an absent one's", async () => {
    presenceConnect("present");
    const off = onCounters("listened", () => {});
    for (const id of ["present", "listened", "absent"]) markCountersDirty(id);
    await until("the present agent's counters", () => cachedCounters("present") !== null, 3000);
    await until("the listened-to agent's counters", () => cachedCounters("listened") !== null, 3000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(cachedCounters("absent"), null, "an absent agent costs nothing");
    off();
});

// #3312 — `b:` counts an unassigned ticket in the agent's court, unless the agent itself may not claim.
test("the backlog counts an unassigned actionable ticket; an agent that may not claim counts only its assignments", async () => {
    const { computeCounters } = await import("./agent-counters.js");
    const { createProject } = await import("./db/projects.js");
    const { upsertSubscription } = await import("./db/subscriptions.js");
    const { submitMessage } = await import("./messages.js");
    const { updateConsumer } = await import("./db.js");
    upsertConsumer({ consumer_id: "boss", kind: "human" });
    upsertConsumer({ consumer_id: "lead-3312", kind: "agent", project: "p-3312" } as never);
    createProject({ name: "p-3312" });
    upsertSubscription("lead-3312", "p-3312", "owner");
    submitMessage({ project: "p-3312", kind: "ticket_created", title: "for the lead", body: "b", by_agent: "boss" });
    assert.equal(computeCounters("lead-3312").backlog, 1, "the lead's unassigned ticket is in its backlog");
    updateConsumer("lead-3312", { can_claim: false });
    assert.equal(computeCounters("lead-3312").backlog, 0, "an agent that may not claim waits for assignments");
});

// #3337 — the bar showed b:3 and counted down while every backlog ticket was at
// rest: a backlog wake starts a rest without an event, so the count stayed.
test("a backlog wake drops the count at once, and the end of the rest brings it back", async () => {
    const { createProject } = await import("./db/projects.js");
    const { upsertSubscription } = await import("./db/subscriptions.js");
    const { submitMessage } = await import("./messages.js");
    const { setAgentCooldown } = await import("./agent-cooldown.js");
    const { getMethod } = await import("./bus/methods.js");
    await import("./bus/methods/read-state.js");
    const { testCaller } = await import("./tests/lib.js");
    upsertConsumer({ consumer_id: "boss", kind: "human" });
    upsertConsumer({ consumer_id: "lead-3337", kind: "agent", project: "p-3337" } as never);
    createProject({ name: "p-3337" });
    upsertSubscription("lead-3337", "p-3337", "owner");
    const t = submitMessage({ project: "p-3337", kind: "ticket_created", title: "resting", body: "b", by_agent: "boss" });
    setAgentCooldown("lead-3337", 2);
    const seen: number[] = [];
    const off = onCounters("lead-3337", (c) => seen.push(c.backlog));
    try {
        markCountersDirty("lead-3337");
        await until("the ticket in the backlog", () => cachedCounters("lead-3337")?.backlog === 1, 3000);
        getMethod("backlog.record_wake")!.run(testCaller("lead-3337"), { ticket_id: t.id });
        await until("the wake to drop it", () => cachedCounters("lead-3337")?.backlog === 0, 3000);
        await until("the rest to end", () => cachedCounters("lead-3337")?.backlog === 1, 6000);
        assert.deepEqual(seen.slice(-3), [1, 0, 1], "1, then 0 at the wake, then 1 when the rest ends");
    } finally {
        off();
    }
});
