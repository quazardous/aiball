/**
 * #2394 david `auuarz` — a consumer that cannot claim keeps the tickets
 * ASSIGNED to it and nothing else. The daemon now returns the right list; the
 * tool says why it is short, so an agent does not read "empty" as "broken".
 * What must hold, driving the real handler with the client stubbed:
 * - asking for one's work as a no-claim consumer carries the warning, and the
 *   rows still come back untouched;
 * - a consumer that can claim gets no warning;
 * - a plain listing never warns: reading is not asking whose court it is in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2394-mcp-"));
process.env.AIBALL_SOCK = "";
const { CL_ENV } = await import("../claude-loop/env-vars.js");
delete process.env[CL_ENV.STATE_DIR];

const { client } = await import("./_helpers.js");
const { registerTicketReadTools } = await import("./ticket-read.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerTicketReadTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers[name] = handler; },
} as never);

const stub = client as unknown as Record<string, unknown>;
stub.listTickets = async () => [{ id: 7, title: "assigned to me" }];
let canClaim = false;
stub.getConsumer = async (id: string) => ({ consumer_id: id, can_claim: canClaim });

async function list(args: Record<string, unknown>, agent: string): Promise<string> {
    (client as unknown as { agentId: string }).agentId = agent;
    const out = await handlers.ticket_list(args);
    return out.content[0].text;
}

test("a no-claim consumer asking for its work is told what its work is", async () => {
    canClaim = false;
    const text = await list({ actionable: true }, "relay-agent");
    assert.match(text, /ASSIGNED to you/, "the warning rides along");
    assert.match(text, /"id": 7/, "and the rows are untouched");
});

test("a consumer that can claim is not warned", async () => {
    canClaim = true;
    const text = await list({ actionable: true }, "lead-agent");
    assert.doesNotMatch(text, /ASSIGNED to you/);
});

test("a plain listing never warns — reading is not asking whose court it is in", async () => {
    canClaim = false;
    const text = await list({ open: true }, "another-relay");
    assert.doesNotMatch(text, /ASSIGNED to you/);
});
