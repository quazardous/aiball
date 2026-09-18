/**
 * #2765 / #2770 — `poll` carries the project's critical ticket, the one the
 * backlog wake names, so an agent reading its state sees it too. Driving the
 * real handler with the client stubbed: what matters is what leaves the tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2770-mcp-"));
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

const stub = client as unknown as Record<string, unknown>;
stub.health = async () => ({ ok: true });
stub.listProjectsDetailed = async () => [{ name: "p", open_count: 3 }];
stub.myPendingTickets = async () => [];
stub.myPendingComments = async () => [];
stub.pingsCount = async () => ({ unread: 0 });
stub.bookends = async () => ({ first: null, last: null });
stub.plansToExecute = async () => ({ plans: [] });
stub.presence = async () => null;
const asked: string[] = [];
let critical: unknown = { id: 2725, title: "the old blocker", holds: 12, last_moved_at: null, quiet: "3 d" };
stub.getProjectCritical = async (project: string) => {
    asked.push(project);
    if (critical instanceof Error) throw critical;
    return { project, critical };
};

async function poll(project: string | null): Promise<Record<string, unknown>> {
    (client as unknown as { defaultProject: string | null }).defaultProject = project;
    const out = await handlers.poll({});
    return JSON.parse(out.content[0].text) as Record<string, unknown>;
}

test("a scoped poll carries the project's critical ticket", async () => {
    const out = await poll("p");
    assert.deepEqual(out.critical, critical);
    assert.deepEqual(asked, ["p"]);
});

test("none, a failure, or an unscoped poll: critical is null, and the poll still answers", async () => {
    critical = null;
    assert.equal((await poll("p")).critical, null);
    critical = new Error("404 on an older daemon");
    const failed = await poll("p");
    assert.equal(failed.critical, null);
    assert.ok("my_pending_tickets" in failed, "the rest of the poll is there");
    asked.length = 0;
    assert.equal((await poll(null)).critical, null);
    assert.deepEqual(asked, [], "an unscoped poll does not ask");
});
