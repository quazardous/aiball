/**
 * #2306 — MCP `ticket_new` must put `comment_only` on the wire. Declared in the
 * schema and destructured in the handler was not enough: the daemon reads the
 * request body, found nothing there, and refused every comment-only ticket.
 *
 * Drives the real handler with the client stubbed, so what is checked is the
 * body the tool sends. The route's own rule is covered by api/comment-only.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2306-"));
process.env.AIBALL_SOCK = "";
const { CL_ENV } = await import("../claude-loop/env-vars.js");
// The loop shell exports its state dir; with it, the handler would record a
// focus ticket and try to post token usage. Neither belongs in this test.
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
stub.postMessage = async (msg: Record<string, unknown>) => { sent.push(msg); return { id: 42 }; };
stub.resolveProject = (p?: string) => p ?? "p-2306";
stub.projectStats = async () => { throw new Error("not needed here"); };

async function create(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    sent.length = 0;
    await handlers.ticket_new({ project: "p-2306", title: "t", body: "b", ...args });
    assert.equal(sent.length, 1, "exactly one message posted");
    return sent[0];
}

test("comment_only: true reaches the daemon", async () => {
    const msg = await create({ comment_only: true });
    assert.equal(msg.kind, "ticket_created");
    assert.equal(msg.comment_only, true);
});

test("with then: plan the decision goes out, and the flag has nothing to add", async () => {
    const msg = await create({ then: "plan", comment_only: true });
    assert.equal(msg.decision_kind, "plan");
    assert.equal(msg.comment_only, undefined);
});

test("with neither, nothing is invented: the daemon's refusal stays the answer", async () => {
    const msg = await create({});
    assert.equal(msg.comment_only, undefined);
    assert.equal(msg.decision_kind, undefined);
});
