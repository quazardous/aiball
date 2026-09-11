/**
 * #2297 — MCP `ticket_reply({then: "wait", wait_for})` must put both on the
 * wire: a comment carrying the `wait` decision and the ticket it waits on. A
 * parameter the schema accepts but the handler does not forward is refused by
 * the daemon ("needs wait_for") for a reason the agent cannot see.
 *
 * Drives the real handler with the client stubbed. The route's own rules are
 * covered by api/then-wait.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2297-mcp-"));
process.env.AIBALL_SOCK = "";
const { CL_ENV } = await import("../claude-loop/env-vars.js");
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
stub.postMessage = async (msg: Record<string, unknown>) => { sent.push(msg); return { id: 44 }; };
stub.getMessage = async (id: number) => ({ id, project: "p-2297", kind: "ticket_created", ticket_id: null });

async function reply(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    sent.length = 0;
    await handlers.ticket_reply({ target_id: 7, body: "b", summary_until: "s", ...args });
    assert.equal(sent.length, 1, "exactly one message posted");
    return sent[0]!;
}

test("then: wait posts the wait decision with the ticket it waits on", async () => {
    const msg = await reply({ then: "wait", wait_for: 12 });
    assert.equal(msg.kind, "comment_added");
    assert.equal(msg.decision_kind, "wait");
    assert.equal(msg.wait_for, 12);
});

test("wait_for is not sent with another verb", async () => {
    assert.equal((await reply({ then: "plan", wait_for: 12 })).wait_for, undefined);
    assert.equal((await reply({ handback: true, wait_for: 12 })).wait_for, undefined);
});
