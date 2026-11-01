/**
 * #4546 — poll's pending tickets are listed as `_status.my_pending` counts them:
 * every project, on a scoped poll too. Pending comments stay scoped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4546-mcp-"));
process.env.AIBALL_SOCK = "";
const { CL_ENV } = await import("../claude-loop/env-vars.js");
delete process.env[CL_ENV.STATE_DIR];

const { client } = await import("./_helpers.js");
const { registerInboxTools } = await import("./inbox.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerInboxTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers[name] = handler; },
} as never);

const here = { id: 1, project: "p" };
const elsewhere = { id: 2, project: "other" };
const asked: Record<string, unknown> = {};
const stub = client as unknown as Record<string, unknown>;
stub.health = async () => ({ ok: true });
stub.listProjectsDetailed = async () => [{ name: "p", open_count: 3 }];
stub.myPendingTickets = async (o: { project?: string | null }) => {
    asked.tickets = o.project;
    return o.project ? [here] : [here, elsewhere];
};
stub.myPendingComments = async (o: { project?: string | null }) => { asked.comments = o.project; return []; };
stub.pingsCount = async () => ({ unread: 0 });
stub.bookends = async () => ({ first: null, last: null });
stub.plansToExecute = async () => ({ plans: [] });
stub.presence = async () => null;
stub.getProjectCritical = async () => ({ critical: null });

test("a scoped poll lists the pending tickets of every project, and keeps its comments scoped", async () => {
    (client as unknown as { defaultProject: string | null }).defaultProject = "p";
    const out = JSON.parse((await handlers.poll({})).content[0].text) as { my_pending_ids: number[]; my_pending_tickets: { project: string }[] };
    assert.equal(asked.tickets, null);
    assert.equal(asked.comments, "p");
    assert.deepEqual(out.my_pending_ids, [1, 2]);
    assert.deepEqual(out.my_pending_tickets.map((t) => t.project), ["p", "other"]);
});
