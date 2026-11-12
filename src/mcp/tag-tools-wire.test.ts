/**
 * #4957 — agents create a tag and tag an existing ticket over MCP. Driving the
 * real handlers with the client stubbed: what matters is what leaves the tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4957-mcp-"));
process.env.AIBALL_SOCK = "";
const { CL_ENV } = await import("../claude-loop/env-vars.js");
delete process.env[CL_ENV.STATE_DIR];

const { client } = await import("./_helpers.js");
const { registerTicketWriteTools } = await import("./ticket-write.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
const server = { registerTool: (name: string, _c: unknown, h: Handler) => { handlers[name] = h; } } as never;
registerTicketWriteTools(server);

const stub = client as unknown as Record<string, unknown>;
const sent: Array<[string, unknown]> = [];
let onTicket = ["os:linux"];
stub.addMessageTag = async (id: number, tag: string) => {
    sent.push(["add", [id, tag]]);
    if (tag === "nope") throw new Error("POST → 400: unknown tag: nope");
    if (!onTicket.includes(tag)) onTicket = [...onTicket, tag];
    return onTicket.map((name, i) => ({ id: i, name }));
};
stub.removeMessageTag = async (id: number, tag: string) => {
    sent.push(["remove", [id, tag]]);
    onTicket = onTicket.filter((t) => t !== tag);
    return onTicket.map((name, i) => ({ id: i, name }));
};
stub.createTag = async (body: Record<string, unknown>) => { sent.push(["create", body]); return { id: 9, ...body }; };
(client as unknown as { defaultProject: string }).defaultProject = "p";

const json = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await handlers[name](args)).content[0].text) as Record<string, any>;

test("tag_create sends the tag to the agent's project by default, or the one named", async () => {
    await json("tag_create", { name: "photocraft", color: "#123456" });
    assert.deepEqual(sent.at(-1), ["create", { name: "photocraft", project: "p", color: "#123456", note: undefined }]);
    await json("tag_create", { name: "x", project: "q", note: "n" });
    assert.deepEqual(sent.at(-1), ["create", { name: "x", project: "q", color: undefined, note: "n" }]);
});

test("ticket_update adds then removes tags, one call each, and answers the ticket's tags", async () => {
    sent.length = 0;
    const r = await json("ticket_update", { ticket_id: 7, add_tags: ["photocraft", "ui"], remove_tags: ["os:linux"] });
    assert.deepEqual(sent, [["add", [7, "photocraft"]], ["add", [7, "ui"]], ["remove", [7, "os:linux"]]]);
    assert.deepEqual(r.tags, ["photocraft", "ui"]);
});

test("an unknown tag is the daemon's refusal, passed on", async () => {
    await assert.rejects(handlers.ticket_update({ ticket_id: 7, add_tags: ["nope"] }), /unknown tag: nope/);
});
