/**
 * #2910 — the milestone reaches the daemon from every MCP tool that takes it:
 * `ticket_update` and `ticket_new` set it, `ticket_list` filters on it,
 * `milestone_list` reads the project's milestones. Driving the real handlers
 * with the client stubbed: what matters is what leaves the tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2910-mcp-"));
process.env.AIBALL_SOCK = "";
const { CL_ENV } = await import("../claude-loop/env-vars.js");
delete process.env[CL_ENV.STATE_DIR];

const { client } = await import("./_helpers.js");
const { registerTicketWriteTools } = await import("./ticket-write.js");
const { registerTicketReadTools } = await import("./ticket-read.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
const server = { registerTool: (name: string, _c: unknown, h: Handler) => { handlers[name] = h; } } as never;
registerTicketWriteTools(server);
registerTicketReadTools(server);

const stub = client as unknown as Record<string, unknown>;
const set: Array<[number, number | null]> = [];
stub.setTicketMilestone = async (id: number, m: number | null) => {
    set.push([id, m]);
    if (m === 999) throw new Error("POST → 403: planning is a human's or a cto agent's gesture");
    return { ticket_id: id, milestone: m === null ? null : { id: m, title: "0.1", released: false } };
};
const listed: Record<string, string | undefined>[] = [];
stub.listTickets = async (q: Record<string, string | undefined>) => { listed.push(q); return []; };
stub.listMilestones = async (project: string) => ({ project, milestones: [{ id: 5, title: "0.1" }] });
stub.postMessage = async () => ({ id: 42 });
stub.projectStats = async () => { throw new Error("no stats"); };
(client as unknown as { defaultProject: string }).defaultProject = "p";

const json = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await handlers[name](args)).content[0].text) as Record<string, any>;

test("ticket_update sets and clears the milestone", async () => {
    assert.deepEqual((await json("ticket_update", { ticket_id: 7, milestone: 5 })).milestone, { id: 5, title: "0.1", released: false });
    assert.equal((await json("ticket_update", { ticket_id: 7, milestone: null })).milestone, null);
    assert.deepEqual(set.slice(-2), [[7, 5], [7, null]]);
});

test("ticket_new sets it once the ticket exists, and a refusal is a warning, not a lost ticket", async () => {
    assert.deepEqual((await json("ticket_new", { title: "t", milestone: 5 })).milestone?.id, 5);
    assert.deepEqual(set.at(-1), [42, 5]);
    const refused = await json("ticket_new", { title: "t", milestone: 999 });
    assert.equal(refused.id, 42, "the ticket is there");
    assert.match(String(refused.warnings), /not put in milestone #999/);
});

test("ticket_list filters on it, and milestone_list reads the project's", async () => {
    await handlers.ticket_list({ milestone: 5 });
    assert.equal(listed.at(-1)?.milestone, "5");
    assert.deepEqual((await json("milestone_list", {})).milestones, [{ id: 5, title: "0.1" }]);
});
