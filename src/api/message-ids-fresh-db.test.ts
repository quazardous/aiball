/**
 * #3014 — on a NEW base, comment ids start above every ticket id. Migration
 * 0007 set the comments' counter to MAX(id)+1 of `_messages`, which is 1 on an
 * empty base, like the tickets': comment 12 and ticket #12 then shared an id,
 * and `/api/messages/12/edit` rewrote the ticket. No counter is seeded here on
 * purpose — the route tests used to seed it, which is how this went unseen.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3014-"));
process.env.AIBALL_SOCK = "";

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getMessage } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");

const P = "p-3014";
/** Every ticket filed here, with the body it must keep. */
const filed = new Map<number, string>();
function ticket(title: string, body: string): number {
    const id = submitMessage({ project: P, kind: "ticket_created", title, body, by_agent: "boss" }).id;
    filed.set(id, body);
    return id;
}
upsertConsumer({ consumer_id: "boss", kind: "human" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3014-h" }).token;
createProject({ name: P });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("the first comment of a new base has an id above every ticket's", () => {
    const tickets = Array.from({ length: 3 }, (_, i) => ticket(`t${i}`, `ticket ${i}`));
    const comment = submitMessage({ project: P, kind: "comment_added", ticket_id: tickets[0], body: "a comment", by_agent: "boss", summary_until: "s" }).id;
    assert.ok(comment >= 1_000_000, `comment id ${comment} collides with the ticket ids ${tickets.join(", ")}`);
});

test("editing a comment edits the comment, never the ticket that shares its number", async () => {
    // Enough tickets that a comment id counted from 1 would name one of them.
    const tickets = Array.from({ length: 12 }, (_, i) => ticket(`u${i}`, `body ${i}`));
    const comment = submitMessage({ project: P, kind: "comment_added", ticket_id: tickets[0], body: "before", by_agent: "boss", summary_until: "s" }).id;
    const r = await fetch(`${BASE}/api/messages/${comment}/edit`, {
        method: "POST",
        headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "probe" }),
    });
    assert.ok(r.status < 300, await r.text());
    assert.equal(getMessage(comment)?.body, "probe");
    for (const [id, body] of filed) assert.equal(getMessage(id)?.body, body, `ticket #${id} untouched`);
});
