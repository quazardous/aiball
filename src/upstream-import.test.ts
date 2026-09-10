/**
 * Upstream coupling phase 2 — importUpstream (Slice 0). Integration test on a
 * throwaway SQLite (AIBALL_HOME): the explicit `gh:owner/repo#N` ref fetches a
 * stubbed issue, creates a coupled ticket, maps labels→tags, sets the
 * per-ticket upstream columns, and stays idempotent (re-import → 409).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1542-"));
// #2219 — pin the upstream transport. It is read from the HOST's global config
// (`$XDG_CONFIG_HOME/aiball/config.yaml`), which AIBALL_HOME does not isolate: on
// a machine where that key is unset (`auto`) and `gh` is installed, `auto`
// picks the real `gh`, the stubbed fetch below is never called, and the test
// reaches GitHub. A private config forcing `http` makes the stub the only path.
const xdg = mkdtempSync(join(tmpdir(), "aiball-upstream-import-xdg-"));
mkdirSync(join(xdg, "aiball"), { recursive: true });
writeFileSync(join(xdg, "aiball", "config.yaml"), "upstream_transport: http\n");
process.env.XDG_CONFIG_HOME = xdg;

const { getDb } = await import("./db/connection.js");
const { eq } = await import("drizzle-orm");
const schema = await import("./schema.js");
const { createProject } = await import("./db/projects.js");
const { listMessageTags } = await import("./db/tags.js");
const { importUpstream, AlreadyCoupledError } = await import("./upstream-import.js");

getDb();
createProject({ name: "up-test" });

function stub(payload: unknown): typeof fetch {
    return (async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
    })) as unknown as typeof fetch;
}

const issue = {
    number: 123,
    title: "Login button unresponsive",
    body: "Clicking login does nothing on Safari.",
    state: "open",
    html_url: "https://github.com/acme/widgets/issues/123",
    labels: [{ name: "bug" }, { name: "safari" }],
};

test("import creates a coupled ticket with columns + tags", async () => {
    const { ticket, external, provider } = await importUpstream(
        { project: "up-test", ref: "gh:acme/widgets#123", by_agent: "importer" },
        { fetchImpl: stub(issue), token: "tok" },
    );
    assert.equal(provider, "github");
    assert.equal(external.num, 123);
    assert.equal(ticket.title, "Login button unresponsive");

    // Coupling columns persisted on the row.
    const row = getDb().select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id)).get();
    assert.equal(row?.upstreamKind, "github");
    assert.equal(row?.upstreamRef, "github:acme/widgets");
    assert.equal(row?.upstreamNum, 123);
    assert.ok(row?.upstreamSyncedAt, "synced_at should be stamped");

    // Labels → tags.
    const tags = listMessageTags(ticket.id).map((t) => t.name).sort();
    assert.deepEqual(tags, ["bug", "safari"]);
});

test("re-import of the same issue is rejected (idempotent, no duplicate)", async () => {
    await assert.rejects(
        () => importUpstream(
            { project: "up-test", ref: "gh:acme/widgets#123", by_agent: "importer" },
            { fetchImpl: stub(issue), token: "tok" },
        ),
        (err: unknown) => err instanceof AlreadyCoupledError,
    );
});

test("an aiball-only ticket carries no upstream columns", () => {
    // Sanity: coupling is opt-in per ticket. A plain ticket stays untouched.
    const db = getDb();
    const { nowIso } = { nowIso: () => new Date(0).toISOString() };
    db.insert(schema.tickets).values({
        id: 999999,
        project: "up-test",
        displaySeq: 999999,
        title: "plain aiball ticket",
        status: "approved",
        createdAt: nowIso(),
    }).run();
    const row = db.select().from(schema.tickets).where(eq(schema.tickets.id, 999999)).get();
    assert.equal(row?.upstreamKind, null);
    assert.equal(row?.upstreamRef, null);
    assert.equal(row?.upstreamNum, null);
});

test("unresolvable ref (no binding, bare form) throws a helpful error", async () => {
    await assert.rejects(
        () => importUpstream(
            { project: "up-test", ref: "gh#500", by_agent: "importer" },
            { fetchImpl: stub(issue), token: "tok" },
        ),
        /can't resolve upstream ref/,
    );
});
