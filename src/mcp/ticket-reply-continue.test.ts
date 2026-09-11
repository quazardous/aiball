/**
 * #2308 — MCP `ticket_reply({then: "continue"})` must put the step on the wire:
 * a comment carrying `step: true` and no decision. Same lesson as #2306: a verb
 * the schema accepts but the handler does not forward is refused by the daemon
 * for a reason the agent cannot see.
 *
 * Drives the real handler with the client stubbed, so what is checked is the
 * body the tool sends. The route's own rule is covered by api/continue.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2308-mcp-"));
process.env.AIBALL_SOCK = "";
const { CL_ENV } = await import("../claude-loop/env-vars.js");
// The loop shell exports its state dir; with it, the handler would record a
// focus ticket. That does not belong in this test.
delete process.env[CL_ENV.STATE_DIR];

const { client } = await import("./_helpers.js");
const { registerTicketWriteTools } = await import("./ticket-write.js");

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
const handlers: Record<string, Handler> = {};
registerTicketWriteTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers[name] = handler; },
} as never);

const sent: Record<string, unknown>[] = [];
const stub = client as unknown as Record<string, unknown>;
stub.postMessage = async (msg: Record<string, unknown>) => { sent.push(msg); return { id: 43 }; };
stub.getMessage = async (id: number) => ({ id, project: "p-2308", kind: "ticket_created", ticket_id: null });

async function reply(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    sent.length = 0;
    await handlers.ticket_reply({ target_id: 7, body: "b", summary_until: "s", ...args });
    assert.equal(sent.length, 1, "exactly one message posted");
    return sent[0];
}

test("then: continue posts a comment carrying the step and no decision", async () => {
    const msg = await reply({ then: "continue" });
    assert.equal(msg.kind, "comment_added");
    assert.equal(msg.step, true);
    assert.equal(msg.decision_kind, undefined);
    assert.equal(msg.ticket_id, 7);
});

test("the other verbs send no step", async () => {
    for (const then of ["plan", "resolved", undefined]) {
        const msg = await reply({ then, comment_only: then ? undefined : true });
        assert.equal(msg.step, undefined, String(then));
    }
});
