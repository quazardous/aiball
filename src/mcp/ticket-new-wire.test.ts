/**
 * #2306 / #2331 — what MCP `ticket_new` puts on the wire. Declared in the schema
 * was never enough: the daemon reads the body the handler sends. A new ticket's
 * handback is deduced by the daemon, so the tool never sends one, and
 * `comment_only` is gone. The route's own rule is covered by api/handback.test.ts.
 *
 * Drives the real handler with the client stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2331-mcp-"));
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
stub.postMessage = async (msg: Record<string, unknown>) => { sent.push(msg); return { id: 42, warnings: ["remind"] }; };
stub.resolveProject = (p?: string) => p ?? "p-2331";
stub.projectStats = async () => { throw new Error("not needed here"); };

async function create(args: Record<string, unknown>): Promise<{ msg: Record<string, unknown>; out: unknown }> {
    sent.length = 0;
    const out = await handlers.ticket_new({ project: "p-2331", title: "t", body: "b", ...args });
    assert.equal(sent.length, 1, "exactly one message posted");
    return { msg: sent[0], out };
}

test("then: plan goes out as the plan decision", async () => {
    const { msg } = await create({ then: "plan" });
    assert.equal(msg.kind, "ticket_created");
    assert.equal(msg.decision_kind, "plan");
});

test("without then, nothing is invented: no decision, no handback, no comment_only", async () => {
    const { msg } = await create({});
    assert.equal(msg.decision_kind, undefined);
    assert.equal("handback" in msg, false);
    assert.equal("comment_only" in msg, false);
});

test("the daemon's warnings reach the agent", async () => {
    const { out } = await create({});
    assert.match(JSON.stringify(out), /remind/);
});
