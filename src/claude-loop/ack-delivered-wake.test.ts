// #3791 — a delivered wake marks as seen all it showed: its head and the rest of its bundle, from the Stop hook as from the kernel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ackDeliveredWake } from "./state.js";

test("the head and every extra of the bundle are marked seen; nothing for a wake with none", async () => {
    const seen: number[] = [];
    const client = { markMessageSeen: async (id: number) => { seen.push(id); return {}; } };
    ackDeliveredWake(client as never, { headMessageId: 10, extraSeenIds: [11, 12] });
    ackDeliveredWake(client as never, { headMessageId: null, extraSeenIds: [] });
    assert.deepEqual(seen, [10, 11, 12]);
});

test("a failed ack does not throw (fire-and-forget)", () => {
    const client = { markMessageSeen: async () => { throw new Error("daemon away"); } };
    assert.doesNotThrow(() => ackDeliveredWake(client as never, { headMessageId: 1, extraSeenIds: [2] }));
});

test("the Stop hook acks a delivered wake's extras, not its head alone", () => {
    const hook = readFileSync(new URL("./stop-hook.ts", import.meta.url), "utf8");
    assert.match(hook, /ackDeliveredWake\(phraseClient, \{ headMessageId, extraSeenIds \}\)/);
});
