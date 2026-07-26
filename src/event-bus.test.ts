/**
 * #836 Phase 1 — pushEvent unit tests.
 * Verifies that the wrapped duo (fanOutPings + emitLifecycle) fires
 * once each, with the lifecycle op + opts propagated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushEvent, onLifecycle } from "./event-bus.js";

function fakeMsg(id: number, kind: string) {
    return {
        id,
        project: "p",
        kind,
        ticket_id: 1,
        parent_id: null,
        title: null,
        body: null,
        by_agent: "me",
        status: "approved" as const,
        created_at: new Date(0).toISOString(),
        decided_at: null,
        decided_by: null,
        matched_rule_id: null,
        human_note: null,
        original_title: null,
        original_body: null,
        intent: null,
        display_seq: 1,
        scope: "default" as const,
        hashid: null,
        postponed_until: null,
        parent_ticket_id: null,
        source_ticket_id: null,
        meta: null,
        assignee: null,
        assigned_by: null,
        assigned_at: null,
        claimant: null,
        claimed_at: null,
    };
}

test("pushEvent emits lifecycle with default op=created", () => {
    const fired: { op: string; msgId: number }[] = [];
    const unsub = onLifecycle((ev) => {
        fired.push({ op: ev.op, msgId: ev.message.id });
    });
    pushEvent(fakeMsg(42, "comment_added") as any);
    unsub();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].op, "created");
    assert.equal(fired[0].msgId, 42);
});

test("pushEvent emits lifecycle with op + opts overrides", () => {
    const fired: any[] = [];
    const unsub = onLifecycle((ev) => fired.push(ev));
    pushEvent(fakeMsg(43, "ticket_created") as any, {
        op: "moved",
        old_project: "src",
    });
    unsub();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].op, "moved");
    assert.equal(fired[0].old_project, "src");
});
