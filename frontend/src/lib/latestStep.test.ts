// #2470 — only the latest step of a thread shows as a step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { latestStepId } from "./latestStep";

const step = (id: number) => ({ id, kind: "comment_added", meta: JSON.stringify({ step: true, step_resume_at: "2026-09-14T10:00:00Z" }) });
const plain = (id: number) => ({ id, kind: "comment_added", meta: JSON.stringify({ summary_until: "s" }) });

test("the latest step wins, whatever order the thread is displayed in", () => {
    assert.equal(latestStepId([step(10), plain(11), step(12), plain(13)]), 12);
    assert.equal(latestStepId([plain(13), step(12), plain(11), step(10)]), 12, "top-down order");
});

test("no step, no latest", () => {
    assert.equal(latestStepId([plain(1), { id: 2, kind: "ticket_closed", meta: null }]), null);
});
