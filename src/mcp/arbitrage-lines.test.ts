// #2198 — `arbitrage` renders as an index. What must hold: one line per
// decision with enough to triage, summaries left out by default (they were 64%
// of the payload) and printed on request, a cut list that SAYS it is cut, and
// superseded amendments marked rather than dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderArbitrage, type ArbitrageRow } from "./arbitrage-lines.js";

const row = (i: number, extra: Partial<ArbitrageRow> = {}): ArbitrageRow => ({
    comment_hashid: `h${String(i).padStart(5, "0")}`,
    ticket_id: 1000 + i,
    ticket_title: `ticket ${i}`,
    ticket_project: i % 2 ? "alpha" : "beta",
    decision_kind: i % 3 ? "plan" : "resolution",
    proposed_by: "some-agent",
    created_at: `2026-09-${String(10 - (i % 9)).padStart(2, "0")}T10:00:00.000Z`,
    summary_until: `state of ticket ${i}: ` + "x".repeat(580),
    ...extra,
});

test("one line per decision, in the order given, with what a triage needs", () => {
    const { lines } = renderArbitrage([row(1), row(2)]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^#1001:h00001\s+plan\s+· alpha · some-agent · 2026-09-09 · ticket 1$/);
    assert.match(lines[1], /^#1002:h00002/);
});

test("summary_until is left out by default and announced; full prints it under its decision", () => {
    const short = renderArbitrage([row(1)]);
    assert.equal(short.lines.join("\n").includes("state of ticket 1"), false);
    assert.ok(short.meta.some((m) => m.includes("full: true")), "the omission is announced");

    const full = renderArbitrage([row(1)], { full: true });
    assert.equal(full.lines.length, 2);
    assert.match(full.lines[1], /^ {4}↳ state of ticket 1: x+$/);
});

test("on a board-sized list the index is a small fraction of the full read", () => {
    const rows = Array.from({ length: 49 }, (_, i) => row(i + 1));
    const size = (r: { meta: string[]; lines: string[] }) => [...r.meta, ...r.lines].join("\n").length;
    const index = size(renderArbitrage(rows));
    const full = size(renderArbitrage(rows, { full: true }));
    assert.ok(index < full / 4, `index ${index} chars vs full ${full}`);
    assert.equal(renderArbitrage(rows).lines.length, 49, "every decision is still listed");
});

test("a cut list says how many decisions it does not show", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i + 1));
    const cut = renderArbitrage(rows, { limit: 2 });
    assert.equal(cut.lines.length, 2);
    assert.match(cut.meta[0], /^5 pending decisions/);
    assert.ok(cut.meta.some((m) => /showing 2 of 5 — 3 not shown/.test(m)), cut.meta.join(" | "));

    const whole = renderArbitrage(rows);
    assert.equal(whole.meta.some((m) => m.startsWith("showing")), false, "no cut, no cut notice");
});

test("a superseded amendment is marked with the live decision, and counted apart", () => {
    const { meta, lines } = renderArbitrage([
        row(1),
        row(2, { ticket_id: 1001, superseded: true, superseded_by: "h00001" }),
    ]);
    assert.match(lines[1], /· superseded by h00001$/);
    assert.match(meta[0], /2 pending decisions on tickets you report — 1 to answer, 1 superseded/);
});

test("nothing waiting reads as nothing waiting", () => {
    const { meta, lines } = renderArbitrage([]);
    assert.deepEqual(lines, []);
    assert.deepEqual(meta, ["0 pending decisions on tickets you report"]);
});
