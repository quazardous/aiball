// #2070 — the rule is pure and tested next door; this pins that it is actually
// WIRED into ticket creation, which the pure test cannot show.
//
// That distinction is the whole point of the ticket: `from_project` has existed
// since #697, is documented, and renders a "from X" badge — and it was NULL on
// every ticket ever filed, because nothing ever set it. A rule nobody calls is
// the same as no rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2070-"));

const { insertMessage } = await import("./messages.js");
const { createProject } = await import("./projects.js");
const { upsertSubscription } = await import("./subscriptions.js");

for (const p of ["jobbox", "BookShepherd", "aiball"]) createProject({ name: p });
upsertSubscription("jobbox-claude", "jobbox", "owner");
upsertSubscription("jobbox-claude", "aiball", "follower");

const file = (project: string, by_agent: string, title: string, from_project?: string) =>
    insertMessage({
        kind: "ticket_created", project, title, by_agent, status: "approved",
        ...(from_project ? { from_project } : {}),
    } as never);

test("filing at home leaves no badge", () => {
    const t = file("jobbox", "jobbox-claude", "an ordinary jobbox ticket");
    assert.equal(t.from_project, null);
});

test("filing next door records where it came from", () => {
    // The exact case: jobbox-claude owns `jobbox` and filed into BookShepherd,
    // where it holds no role at all.
    const t = file("BookShepherd", "jobbox-claude", "a jbx design ticket, misfiled");
    assert.equal(t.from_project, "jobbox");
});

test("a project you merely follow counts as home enough to stay silent", () => {
    const t = file("aiball", "jobbox-claude", "a real cross-project ask");
    assert.equal(t.from_project, null, "subscribed there → not a crossing");
});

test("an explicit value always wins over the inference", () => {
    // The caller knows something we don't; inference only fills a blank.
    const t = file("BookShepherd", "jobbox-claude", "deliberate", "somewhere-else");
    assert.equal(t.from_project, "somewhere-else");
});

test("an unknown author is not guessed at", () => {
    // No subscriptions → no origin. Branding a brand-new agent's first ticket
    // as foreign would be worse than saying nothing.
    const t = file("BookShepherd", "nobody-claude", "first ticket ever");
    assert.equal(t.from_project, null);
});

test("comments are untouched — this is a ticket-creation concern", () => {
    const parent = file("jobbox", "jobbox-claude", "parent");
    const c = insertMessage({
        kind: "comment_added", project: "BookShepherd", ticket_id: parent.id,
        body: "a reply from elsewhere", by_agent: "jobbox-claude", status: "approved",
    } as never);
    assert.equal(c.from_project ?? null, null);
});
