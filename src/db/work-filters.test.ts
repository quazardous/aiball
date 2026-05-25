// #447 — pure tests for the work-filter gate predicate. node:test, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketPassesWorkFilters, type WorkFilter } from "./work-filters.js";

function f(p: Partial<WorkFilter>): WorkFilter {
    return {
        id: p.id ?? 1,
        consumer_id: p.consumer_id ?? "agent",
        project: p.project ?? null,
        mode: p.mode ?? "only",
        match_tags: p.match_tags ?? [],
        enabled: p.enabled ?? 1,
        position: p.position ?? 0,
        note: p.note ?? null,
        created_at: p.created_at ?? "2026-01-01T00:00:00.000Z",
    };
}

test("no filters → everything passes", () => {
    assert.equal(ticketPassesWorkFilters("aiball", ["win"], []), true);
    assert.equal(ticketPassesWorkFilters("aiball", [], []), true);
});

test("only: passes when the ticket carries a listed tag, else filtered", () => {
    const only = [f({ mode: "only", match_tags: ["win"] })];
    assert.equal(ticketPassesWorkFilters("aiball", ["win"], only), true);
    assert.equal(ticketPassesWorkFilters("aiball", ["linux"], only), false);
    assert.equal(ticketPassesWorkFilters("aiball", [], only), false); // untagged → excluded under an only-filter
});

test("only: any-of — matching any one listed tag is enough", () => {
    const only = [f({ mode: "only", match_tags: ["win", "urgent"] })];
    assert.equal(ticketPassesWorkFilters("aiball", ["urgent"], only), true);
    assert.equal(ticketPassesWorkFilters("aiball", ["x", "win"], only), true);
    assert.equal(ticketPassesWorkFilters("aiball", ["x"], only), false);
});

test("except: filtered out when the ticket matches, else passes", () => {
    const except = [f({ mode: "except", match_tags: ["wip"] })];
    assert.equal(ticketPassesWorkFilters("aiball", ["wip"], except), false);
    assert.equal(ticketPassesWorkFilters("aiball", ["win"], except), true);
    assert.equal(ticketPassesWorkFilters("aiball", [], except), true);
});

test("project scope: null applies everywhere; a set project only applies to its project", () => {
    const scoped = [f({ mode: "only", match_tags: ["win"], project: "aiball-windows" })];
    // applies in its project
    assert.equal(ticketPassesWorkFilters("aiball-windows", ["win"], scoped), true);
    assert.equal(ticketPassesWorkFilters("aiball-windows", ["x"], scoped), false);
    // NOT applicable to another project → passes regardless
    assert.equal(ticketPassesWorkFilters("aiball", ["x"], scoped), true);
});

test("except wins over only when both match", () => {
    const filters = [
        f({ id: 1, mode: "only", match_tags: ["win"] }),
        f({ id: 2, mode: "except", match_tags: ["blocked"] }),
    ];
    // matches only(win) but also except(blocked) → excluded
    assert.equal(ticketPassesWorkFilters("aiball", ["win", "blocked"], filters), false);
    // matches only(win), no except → passes
    assert.equal(ticketPassesWorkFilters("aiball", ["win"], filters), true);
});
