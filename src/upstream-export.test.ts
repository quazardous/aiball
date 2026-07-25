/**
 * Upstream coupling phase 2 — exportUpstream (Slice 1). Integration test on a
 * throwaway SQLite: create a ticket, export it (stubbed createIssue) with an
 * explicit repo, assert the ticket gets coupled to the new issue. Guards:
 * already-coupled → 409, unknown ticket → error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1542x-"));

const { getDb } = await import("./db/connection.js");
const { eq } = await import("drizzle-orm");
const schema = await import("./schema.js");
const { createProject } = await import("./db/projects.js");
const { submitMessage } = await import("./messages.js");
const { exportUpstream } = await import("./upstream-export.js");
const { AlreadyCoupledError } = await import("./upstream-import.js");

getDb();
createProject({ name: "exp-test" });

function stubCreate(payload: unknown): typeof fetch {
    return (async () => ({
        ok: true,
        status: 201,
        json: async () => payload,
    })) as unknown as typeof fetch;
}

const created = {
    number: 501,
    title: "Ticket exported",
    body: "from aiball",
    state: "open",
    html_url: "https://github.com/acme/widgets/issues/501",
};

function makeTicket(title: string): number {
    const t = submitMessage({
        project: "exp-test",
        kind: "ticket_created",
        title,
        body: "please fix",
        by_agent: "exporter",
    });
    return t.id;
}

test("export creates an issue and couples the ticket", async () => {
    const id = makeTicket("Broken export");
    const { ticket, external, provider } = await exportUpstream(
        { ticket_id: id, repo: "acme/widgets", by_agent: "exporter" },
        { fetchImpl: stubCreate(created), token: "wtok" },
    );
    assert.equal(provider, "github");
    assert.equal(external.num, 501);

    const row = getDb().select().from(schema.tickets).where(eq(schema.tickets.id, id)).get();
    assert.equal(row?.upstreamKind, "github");
    assert.equal(row?.upstreamRef, "github:acme/widgets");
    assert.equal(row?.upstreamNum, 501);
    assert.ok(row?.upstreamSyncedAt);
    assert.equal(ticket.upstream_num, 501);
});

test("exporting an already-coupled ticket is refused", async () => {
    const id = makeTicket("Already linked");
    await exportUpstream(
        { ticket_id: id, repo: "acme/widgets" },
        { fetchImpl: stubCreate(created), token: "wtok" },
    );
    await assert.rejects(
        () => exportUpstream(
            { ticket_id: id, repo: "acme/widgets" },
            { fetchImpl: stubCreate(created), token: "wtok" },
        ),
        (err: unknown) => err instanceof AlreadyCoupledError,
    );
});

test("export of a nonexistent ticket throws", async () => {
    await assert.rejects(
        () => exportUpstream(
            { ticket_id: 424242, repo: "acme/widgets" },
            { fetchImpl: stubCreate(created), token: "wtok" },
        ),
        /not found/,
    );
});

test("export without a binding and without --repo throws a helpful error", async () => {
    const id = makeTicket("No target");
    await assert.rejects(
        () => exportUpstream(
            { ticket_id: id },
            { fetchImpl: stubCreate(created), token: "wtok" },
        ),
        /no default github binding/,
    );
});
