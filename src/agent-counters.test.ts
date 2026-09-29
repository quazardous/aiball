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
