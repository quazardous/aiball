/**
 * #2339 — what poll's pending lists ask the daemon for. The route test proves
 * `open=1` drops closed tickets; this one proves the MCP client sends it, for the
 * tickets only: a comment awaiting moderation has no open or closed of its own.
 *
 * Drives the real client with its transport stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2339-mcp-"));
process.env.AIBALL_SOCK = "";

const { client } = await import("./_helpers.js");

const paths: string[] = [];
(client as unknown as Record<string, unknown>).http = async (_method: string, path: string) => { paths.push(path); return []; };

test("the pending tickets poll lists are the open ones, the pending comments are not filtered", async () => {
    await client.myPendingTickets({ project: "p", summary: true, limit: 51 });
    await client.myPendingComments({ project: "p", summary: true, limit: 51 });
    const [tickets, comments] = paths.map((p) => new URLSearchParams(p.split("?")[1]));
    assert.equal(tickets!.get("kind"), "ticket_created");
    assert.equal(tickets!.get("open"), "1");
    assert.equal(comments!.get("kind"), "comment_added");
    assert.equal(comments!.get("open"), null);
});
