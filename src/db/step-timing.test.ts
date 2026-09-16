/**
 * #2629 — the indicator for `continue_after_minutes`: per delay bucket, steps
 * that came back early (< half the delay), on time, late (> 1.1×) or not yet,
 * where "came back" = the same agent next spoke on that ticket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2629-"));
process.env.AIBALL_SOCK = "";

const { stepTimingReport, stepTimingRows } = await import("./step-timing.js");
const { getDb } = await import("./connection.js");

test("buckets split early / on time / late / not back, and a 0-minute step is not counted", () => {
    const r = stepTimingReport([
        { declared_minutes: 10, actual_minutes: 3 },   // early
        { declared_minutes: 10, actual_minutes: 5 },   // on time: exactly half
        { declared_minutes: 10, actual_minutes: 11 },  // on time: exactly 1.1×
        { declared_minutes: 10, actual_minutes: 12 },  // late
        { declared_minutes: 20, actual_minutes: null }, // not back
        { declared_minutes: 90, actual_minutes: 30 },  // 61+, early
        { declared_minutes: 0, actual_minutes: 1 },    // carry on at once: no bucket
    ]);
    assert.deepEqual(r.map((b) => [b.bucket, b.steps, b.early, b.on_time, b.late, b.pending]), [
        ["1-15", 4, 1, 2, 1, 0],
        ["16-30", 1, 0, 0, 0, 1],
        ["31-60", 0, 0, 0, 0, 0],
        ["61+", 1, 1, 0, 0, 0],
    ]);
    assert.equal(r[0].avg_declared, 10);
});

test("from the thread: the same agent's next message on the ticket, not someone else's, filtered by project and date", () => {
    const db = getDb();
    const at = (min: number) => new Date(Date.parse("2026-09-16T10:00:00Z") + min * 60_000).toISOString();
    const ticket = (id: number, project: string) => db.run(sql`INSERT INTO tickets (id, project, display_seq, title, status, created_at) VALUES (${id}, ${project}, ${id}, 't', 'approved', ${at(0)})`);
    let seq = 0;
    const msg = (ticketId: number, by: string, min: number, meta: object | null) =>
        db.run(sql`INSERT INTO _messages (ticket_id, display_seq, kind, status, created_at, by_agent, meta) VALUES (${ticketId}, ${++seq}, 'comment_added', 'approved', ${at(min)}, ${by}, ${meta ? JSON.stringify(meta) : null})`);
    ticket(9001, "pa");
    ticket(9002, "pb");
    ticket(9003, "pb");
    // pa: a 20-minute step; a human replies at 2, the agent itself comes back at 25.
    msg(9001, "agent-a", 0, { step: true, step_resume_at: at(20) });
    msg(9001, "david", 2, null);
    msg(9001, "agent-a", 25, null);
    // pb: a 60-minute step nobody came back to.
    msg(9002, "agent-b", 0, { step: true, step_resume_at: at(60) });
    // A step without a delay is not in the indicator.
    msg(9003, "agent-b", 1, { step: true });

    assert.deepEqual(stepTimingRows({ project: "pa" }), [{ declared_minutes: 20, actual_minutes: 25 }], "the human's reply is not the agent coming back");
    assert.deepEqual(stepTimingRows({ project: "pb" }), [{ declared_minutes: 60, actual_minutes: null }]);
    assert.equal(stepTimingRows({}).length, 2);
    assert.equal(stepTimingRows({ since: at(5) }).length, 0);
});

test("every place that asks for continue_after_minutes asks for the soonest a look is worth it", async () => {
    const { readFileSync } = await import("node:fs");
    const root = join(import.meta.dirname, "..", "..");
    const places = ["src/mcp/ticket-write.ts", "src/claude-loop/state.ts", "config/defaults/claude-loop-pings.yaml", "skills/aiball/SKILL.md", "MCP-CLIENT.md", "src/messages.ts"];
    for (const p of places) {
        const text = readFileSync(join(root, p), "utf8").replace(/\s+/g, " ");
        assert.match(text, /the soonest a look is worth it/, p);
        assert.doesNotMatch(text, /the real delay/, `${p} still asks for the real delay`);
    }
    const yaml = readFileSync(join(root, "config/defaults/claude-loop-pings.yaml"), "utf8");
    assert.equal(yaml.match(/the soonest a look is worth it/g)?.length, 3, "all three tones");
});
