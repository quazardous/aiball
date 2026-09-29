// #457 slice 4 — integration tests for the automation CRUD methods, over the
// bus as a client holding a real bearer token calls them (minted in-test so
// node:test reaches it without the e2e harness).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway DB BEFORE any module that reads paths.
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-457-slice4-"));
process.env.AIBALL_SOCK = ""; // #3241 — never the live daemon's socket, even run directly

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { ensureConsumer } = await import("../db.js");

ensureConsumer("test-agent");
const TOKEN = issueToken({ kind: "agent", consumer_id: "test-agent", label: "slice4-test" }).token;

async function req(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
    const r = await asToken(TOKEN, method, params);
    return { status: r.status, body: r.json };
}

test("POST /automation/rules : creates a rule with triggers union + assign action", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created", "ticket_tagged"],
        match_project: "proj-x",
        match_tags: ["win"],
        action: { kind: "assign", consumer_id: "aiball-windows" },
        note: "win → windows",
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.deepEqual(body.triggers, ["ticket_created", "ticket_tagged"]);
    assert.equal((body.action as { kind: string }).kind, "assign");
    assert.equal((body.action as { consumer_id: string }).consumer_id, "aiball-windows");
    assert.equal(body.enabled, 1);
});

test("POST /automation/rules : rejects unknown trigger", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["not_a_trigger"],
        action: { kind: "decision", decision: "auto" },
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /unknown trigger/);
});

test("POST /automation/rules : rejects empty triggers", async () => {
    const r = await req("automation.create_rule", {
        triggers: [],
        action: { kind: "decision", decision: "auto" },
    });
    assert.equal(r.status, 400);
});

test("POST /automation/rules : rejects assign without consumer_id", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        action: { kind: "assign" },
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /consumer_id/);
});

test("POST /automation/rules : accepts a single trigger string (not just arrays)", async () => {
    const r = await req("automation.create_rule", {
        triggers: "ticket_tagged",
        match_tag_added: "linux",
        action: { kind: "assign", consumer_id: "aiball-linux" },
    });
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as { triggers: string[] }).triggers, ["ticket_tagged"]);
});

test("GET /automation/rules : lists every rule, ordered by (position, id)", async () => {
    const r = await req("automation.rules");
    assert.equal(r.status, 200);
    const all = r.body as Array<{ id: number; position: number }>;
    // Slice 3 : YAML rules (id < 0) may be appended AFTER the DB rows. Their
    // declaration order is meaningful, not their id, so the position-asc /
    // id-asc invariant only applies to the DB slice.
    const dbRows = all.filter((row) => row.id > 0);
    assert.ok(dbRows.length >= 2, `at least the DB rules we created above are there (saw ${dbRows.length})`);
    for (let i = 1; i < dbRows.length; i++) {
        const prev = dbRows[i - 1]!;
        const cur = dbRows[i]!;
        assert.ok(
            prev.position < cur.position || (prev.position === cur.position && prev.id < cur.id),
            "DB rules ordered by (position asc, id asc)",
        );
    }
});

test("GET /automation/rules?trigger=… : filters to rules listing that trigger", async () => {
    const r = await req("automation.rules", { trigger: "ticket_tagged" });
    assert.equal(r.status, 200);
    const rows = r.body as Array<{ triggers: string[] }>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
        assert.ok(row.triggers.includes("ticket_tagged"), "every row carries ticket_tagged");
    }
});

test("PATCH /automation/rules/:id : flips enabled", async () => {
    const created = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        action: { kind: "decision", decision: "review" },
    });
    const id = (created.body as { id: number }).id;
    const r = await req("automation.update_rule", { id, enabled: false });
    assert.equal(r.status, 200);
    assert.equal((r.body as { enabled: number }).enabled, 0);

    const back = await req("automation.update_rule", { id, enabled: true });
    assert.equal((back.body as { enabled: number }).enabled, 1);
});

test("PATCH /automation/rules/:id : rejects non-boolean enabled", async () => {
    const r = await req("automation.update_rule", { id: 1, enabled: "yes" });
    assert.equal(r.status, 400);
});

test("DELETE /automation/rules/:id : removes the row", async () => {
    const created = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        action: { kind: "decision", decision: "auto" },
    });
    const id = (created.body as { id: number }).id;
    const r = await req("automation.delete_rule", { id });
    assert.equal(r.status, 200);
    // Confirm it's gone via list.
    const list = await req("automation.rules");
    const rows = list.body as Array<{ id: number }>;
    assert.ok(!rows.some((row) => row.id === id), "deleted row no longer surfaces in list");
});

// ---------------------------------------------------------------------------
// Slice 5.2 — `expression` validator on POST.
// ---------------------------------------------------------------------------

test("POST /automation/rules : accepts a valid expression tree (OR of AND + leaf)", async () => {
    const tree = {
        kind: "or",
        children: [
            {
                kind: "and",
                children: [
                    { kind: "leaf", field: "project", op: "eq", value: "aiball" },
                    { kind: "leaf", field: "tags", op: "includes", value: "win" },
                ],
            },
            { kind: "leaf", field: "intent", op: "eq", value: "urgent" },
        ],
    };
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        expression: tree,
        action: { kind: "assign", consumer_id: "alice" },
    });
    assert.equal(r.status, 200);
    // The server echoes the canonical tree (decoded then re-emitted).
    assert.deepEqual((r.body as { expression: unknown }).expression, tree);
});

test("POST /automation/rules : rejects a tree with unknown kind", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        expression: { kind: "xor", children: [] }, // xor isn't a thing
        action: { kind: "decision", decision: "auto" },
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /malformed condition tree/);
});

test("POST /automation/rules : rejects a leaf with unknown op", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        expression: { kind: "leaf", field: "project", op: "matches", value: "aiball" },
        action: { kind: "decision", decision: "auto" },
    });
    assert.equal(r.status, 400);
});

test("POST /automation/rules : rejects a leaf with unknown field", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        expression: { kind: "leaf", field: "secret_field", op: "eq", value: "x" },
        action: { kind: "decision", decision: "auto" },
    });
    assert.equal(r.status, 400);
});

test("POST /automation/rules : rejects an `and` whose children isn't an array", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        expression: { kind: "and", children: "not an array" },
        action: { kind: "decision", decision: "auto" },
    });
    assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Slice 5.5 — `actions` stack on POST.
// ---------------------------------------------------------------------------

test("POST /automation/rules : accepts an actions[] stack of 2", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_tagged"],
        match_tag_added: "win",
        actions: [
            { kind: "assign", consumer_id: "aiball-windows" },
            { kind: "set_priority", priority: "high" },
        ],
    });
    assert.equal(r.status, 200);
    const body = r.body as { actions: unknown[]; action: { kind: string } };
    assert.equal(body.actions.length, 2);
    // `action` (back-compat single) mirrors the first entry.
    assert.equal(body.action.kind, "assign");
});

test("POST /automation/rules : rejects empty actions array", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        actions: [],
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /at least one/);
});

test("POST /automation/rules : rejects actions item with bad kind", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        actions: [
            { kind: "assign", consumer_id: "agent-a" },
            { kind: "destroy_the_planet" }, // not a thing
        ],
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /actions\[1\]/);
});

test("POST /automation/rules : actions wins when both action + actions provided", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        action: { kind: "decision", decision: "auto" }, // would-be legacy
        actions: [{ kind: "assign", consumer_id: "agent-a" }],
    });
    assert.equal(r.status, 200);
    const body = r.body as { actions: { kind: string }[]; action: { kind: string } };
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0]!.kind, "assign", "actions wins");
    assert.equal(body.action.kind, "assign");
});

test("POST /automation/rules : legacy single action still works (no actions field)", async () => {
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        action: { kind: "decision", decision: "review" },
    });
    assert.equal(r.status, 200);
    const body = r.body as { actions: { kind: string }[]; action: { kind: string } };
    assert.deepEqual(body.actions, [{ kind: "decision", decision: "review" }]);
    assert.equal(body.action.kind, "decision");
});

test("POST /automation/rules : expression overrides flat match_*", async () => {
    // When both are present, expression wins (it's the canonical surface).
    // Flat fields get stored but the engine reads through expression.
    const r = await req("automation.create_rule", {
        triggers: ["ticket_created"],
        match_project: "should-be-ignored",
        match_tags: ["should-be-ignored"],
        expression: { kind: "leaf", field: "intent", op: "eq", value: "urgent" },
        action: { kind: "decision", decision: "review" },
    });
    assert.equal(r.status, 200);
    const body = r.body as { expression: { kind: string; field?: string; value?: unknown } };
    assert.equal(body.expression.kind, "leaf");
    assert.equal(body.expression.field, "intent");
    assert.equal(body.expression.value, "urgent");
});

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
});
