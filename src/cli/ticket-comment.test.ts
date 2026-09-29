// #3174 — `aiball ticket comment` sends the ticket's state (`summary_until`) when given, so an agent can comment from the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

process.env.AIBALL_SOCK = "";
const { AiballClient } = await import("../client.js");
const { registerTicketCommands } = await import("./ticket.js");

const posted: Record<string, unknown>[] = [];
(AiballClient.prototype as unknown as { postMessage: (b: Record<string, unknown>) => Promise<unknown> }).postMessage = async (b) => {
    posted.push(b);
    return { id: 1, kind: "comment_added", status: "approved" };
};

async function run(...args: string[]): Promise<Record<string, unknown>> {
    const program = new Command().exitOverride().option("--json").option("--human");
    registerTicketCommands(program);
    const log = console.log;
    console.log = () => {};
    try {
        await program.parseAsync(["node", "aiball", "ticket", "comment", "--id", "7", "--project", "p", "--body", "done", "--commits", "none", "--handback", ...args]);
    } finally {
        console.log = log;
    }
    return posted.at(-1)!;
}

test("--summary goes out as summary_until", async () => {
    const b = await run("--by", "worker", "--summary", "shipped; awaiting review");
    assert.equal(b.summary_until, "shipped; awaiting review");
    assert.equal(b.kind, "comment_added");
    assert.equal(b.commits, "none", "the daemon reads \"none\"");
    assert.equal(b.handback, true);
});

// #3252 — the daemon files it in the ticket's project and knows its author.
test("neither the project nor the author goes out", async () => {
    const b = await run("--by", "worker", "--summary", "s");
    assert.equal("project" in b, false);
    assert.equal("by_agent" in b, false);
});

test("without --summary, nothing is invented: the bus says what is missing", async () => {
    const b = await run("--by", "worker");
    assert.equal("summary_until" in b, false);
});
