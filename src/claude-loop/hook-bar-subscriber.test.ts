// #652 Slice 6 — hook-bar-subscriber unit tests.
// Run: `npx tsx --test src/claude-loop/hook-bar-subscriber.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installHookBarSubscriber, paintFromEvent, type BarPainter } from "./hook-bar-subscriber.js";
import { getHookService, resetHookServiceForTests } from "./hook-service.js";
import { LOOP_STATUS } from "./state.js";

/** Recording painter — captures every call so tests can assert on args. */
function recordingPainter(): BarPainter & { calls: { name: string; status: string; sub?: string | number }[] } {
    const calls: { name: string; status: string; sub?: string | number }[] = [];
    const fn: BarPainter = (name, status, sub) => { calls.push({ name, status, sub }); };
    return Object.assign(fn, { calls });
}

test("paintFromEvent: UserPromptSubmit → painter(name, BUSY)", () => {
    const painter = recordingPainter();
    paintFromEvent("my-session", { kind: "UserPromptSubmit", from_auto_wake: false, at_ms: 0 }, painter);
    assert.equal(painter.calls.length, 1);
    assert.deepEqual(painter.calls[0], { name: "my-session", status: LOOP_STATUS.BUSY, sub: undefined });
});

test("paintFromEvent: UserPromptSubmit from_auto_wake=true → also paints BUSY", () => {
    const painter = recordingPainter();
    paintFromEvent("s", { kind: "UserPromptSubmit", from_auto_wake: true, at_ms: 0 }, painter);
    assert.equal(painter.calls.length, 1);
    assert.equal(painter.calls[0].status, LOOP_STATUS.BUSY);
});

test("paintFromEvent: SessionStart → no paint (owned by timer bootEnded handler)", () => {
    const painter = recordingPainter();
    paintFromEvent("s", { kind: "SessionStart", source: "resume", at_ms: 0 }, painter);
    assert.equal(painter.calls.length, 0);
});

test("paintFromEvent: Stop → no paint (owned by stop-hook for now)", () => {
    const painter = recordingPainter();
    paintFromEvent("s", { kind: "Stop", at_ms: 0 }, painter);
    assert.equal(painter.calls.length, 0);
});

test("paintFromEvent: PreToolUse → no paint (doesn't change bar state)", () => {
    const painter = recordingPainter();
    paintFromEvent("s", { kind: "PreToolUse", tool_name: "Bash", at_ms: 0 }, painter);
    assert.equal(painter.calls.length, 0);
});

test("installHookBarSubscriber: subscribes to HookService → paints on event", () => {
    resetHookServiceForTests();
    const painter = recordingPainter();
    const sub = installHookBarSubscriber("my-session", painter);
    try {
        getHookService().emit({ kind: "UserPromptSubmit", from_auto_wake: false, at_ms: 1 });
        assert.equal(painter.calls.length, 1);
        assert.equal(painter.calls[0].name, "my-session");
    } finally {
        sub.close();
    }
});

test("installHookBarSubscriber: close() stops further paints", () => {
    resetHookServiceForTests();
    const painter = recordingPainter();
    const sub = installHookBarSubscriber("s", painter);
    sub.close();
    getHookService().emit({ kind: "UserPromptSubmit", from_auto_wake: false, at_ms: 1 });
    assert.equal(painter.calls.length, 0);
});

test("installHookBarSubscriber: close() is idempotent", () => {
    resetHookServiceForTests();
    const sub = installHookBarSubscriber("s", recordingPainter());
    sub.close();
    sub.close();  // second close = no-op, doesn't throw
});

test("installHookBarSubscriber: throwing painter doesn't crash the subscriber", () => {
    resetHookServiceForTests();
    let calls = 0;
    const throwingPainter: BarPainter = () => { calls++; throw new Error("boom"); };
    const sub = installHookBarSubscriber("s", throwingPainter);
    try {
        // Should NOT throw — the subscriber catches.
        getHookService().emit({ kind: "UserPromptSubmit", from_auto_wake: false, at_ms: 1 });
        // A second emit should still fire (subscriber not torn down).
        getHookService().emit({ kind: "UserPromptSubmit", from_auto_wake: true, at_ms: 2 });
        assert.equal(calls, 2);
    } finally {
        sub.close();
    }
});

test("installHookBarSubscriber: ignores events other than UserPromptSubmit (today)", () => {
    resetHookServiceForTests();
    const painter = recordingPainter();
    const sub = installHookBarSubscriber("s", painter);
    try {
        getHookService().emit({ kind: "SessionStart", source: "resume", at_ms: 1 });
        getHookService().emit({ kind: "Stop", at_ms: 2 });
        getHookService().emit({ kind: "PreToolUse", tool_name: "Bash", at_ms: 3 });
        assert.equal(painter.calls.length, 0);
    } finally {
        sub.close();
    }
});
