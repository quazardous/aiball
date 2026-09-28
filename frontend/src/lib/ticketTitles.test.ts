// #3258 — a ticket's title is asked once, shared by concurrent callers, and a failure is remembered.
import test from "node:test";
import assert from "node:assert/strict";
import { cachedTicketTitle, resetTicketTitlesForTests, ticketTitle, ticketTooltip } from "./ticketTitles";

test("asked once per ticket: concurrent and later callers share the one request", async () => {
    const calls: number[] = [];
    resetTicketTitlesForTests(async (id) => { calls.push(id); return `title ${id}`; });
    assert.equal(cachedTicketTitle(7), undefined, "not asked yet");
    const [a, b] = await Promise.all([ticketTitle(7), ticketTitle(7)]);
    assert.deepEqual([a, b], ["title 7", "title 7"]);
    assert.equal(await ticketTitle(7), "title 7");
    assert.deepEqual(calls, [7], "one request for the three hovers");
    assert.equal(cachedTicketTitle(7), "title 7");
});

test("a ticket the board cannot name is null, remembered, not asked again", async () => {
    let calls = 0;
    resetTicketTitlesForTests(async () => { calls++; throw new Error("the bus is down"); });
    assert.equal(await ticketTitle(9), null);
    assert.equal(await ticketTitle(9), null);
    assert.equal(calls, 1);
    assert.equal(cachedTicketTitle(9), null);
});

test("the tooltip names the ticket and its title", () => {
    assert.equal(ticketTooltip(3244, "R4 — perf"), "#3244 — R4 — perf");
});
