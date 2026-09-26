/**
 * #2339 — what poll's pending lists ask the daemon for. The route test proves
 * `open=1` drops closed tickets; this one proves the MCP client sends it, for the
 * tickets only: a comment awaiting moderation has no open or closed of its own.
 *
 * Drives the real client with its transport stubbed (#3067: the bus call).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2339-mcp-"));
process.env.AIBALL_SOCK = "";

const { client } = await import("./_helpers.js");

const sent: { method: string; params: Record<string, unknown> }[] = [];
(client as unknown as Record<string, unknown>).call = async (method: string, params: Record<string, unknown>) => { sent.push({ method, params }); return []; };

test("the pending tickets poll lists are the open ones, the pending comments are not filtered", async () => {
    await client.myPendingTickets({ project: "p", summary: true, limit: 51 });
    await client.myPendingComments({ project: "p", summary: true, limit: 51 });
    assert.deepEqual(sent.map((s) => s.method), ["message.list", "message.list"]);
    const [tickets, comments] = sent.map((s) => s.params);
    assert.equal(tickets!.kind, "ticket_created");
    assert.equal(tickets!.open, true);
    assert.equal(comments!.kind, "comment_added");
    assert.equal(comments!.open, undefined);
});
