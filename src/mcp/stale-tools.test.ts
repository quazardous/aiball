/**
 * #4794 — an MCP server whose tools changed on disk since it started says so,
 * and a plan option's key it does not know reaches the daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchTools } from "./stale-tools.js";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4794-"));
process.env.AIBALL_SOCK = "";

function install(): string {
    const root = mkdtempSync(join(tmpdir(), "aiball-4794-root-"));
    mkdirSync(join(root, "src/mcp"), { recursive: true });
    writeFileSync(join(root, "src/mcp.ts"), "server");
    writeFileSync(join(root, "src/mcp/ticket-write.ts"), "schema v1");
    writeFileSync(join(root, "src/mcp/ticket-write.test.ts"), "test v1");
    writeFileSync(join(root, "src/decisions.ts"), "levels v1");
    writeFileSync(join(root, "src/kernel.ts"), "loop v1");
    return root;
}

test("tools unchanged on disk: nothing said", () => {
    const tools = watchTools(install(), 0);
    assert.equal(tools.check(), null);
});

test("a tool's source changed after the start: every answer says so, and how to reload", () => {
    const root = install();
    const tools = watchTools(root, 0);
    writeFileSync(join(root, "src/mcp/ticket-write.ts"), "schema v2");
    assert.match(tools.check() ?? "", /tools changed on disk.*restart/);
    writeFileSync(join(root, "src/mcp/ticket-write.ts"), "schema v1");
    assert.notEqual(tools.check(), null, "once stale, stale: this process still runs the old code");
});

test("a module the schemas read counts; a test or a file outside the tools does not", () => {
    const root = install();
    const tools = watchTools(root, 0);
    writeFileSync(join(root, "src/mcp/ticket-write.test.ts"), "test v2");
    writeFileSync(join(root, "src/kernel.ts"), "loop v2");
    assert.equal(tools.check(), null);
    writeFileSync(join(root, "src/decisions.ts"), "levels v2");
    assert.notEqual(tools.check(), null);
});

test("the disk is read again only after the recheck delay", () => {
    const root = install();
    const tools = watchTools(root, 30_000);
    assert.equal(tools.check(1_000_000), null);
    writeFileSync(join(root, "src/mcp.ts"), "server v2");
    assert.equal(tools.check(1_010_000), null, "inside the delay: the last read stands");
    assert.notEqual(tools.check(1_031_000), null);
});

test("a plan option's key this server does not know goes through to the daemon", async () => {
    const { OPTION_SCHEMA } = await import("./ticket-write.js");
    const parsed = OPTION_SCHEMA.parse({ key: "A", label: "one", recommended: true, someday: "new" });
    assert.equal((parsed as Record<string, unknown>).someday, "new");
});
