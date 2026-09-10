// #2201 — which MCP tools an agent type is shown. What must hold: every tool
// the server can register has a declared audience (and the table names nothing
// that no longer exists), the default type sees every tool as before, a gated
// server really skips what a type is not shown, and an unknown type reads as
// the default rather than hiding tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2201-"));
process.env.AIBALL_SOCK = "";

const { TOOL_AUDIENCE, gateServer, isToolVisible, normalizeAgentType } = await import("./tool-audience.js");
const registrars = [
    (await import("./ticket-write.js")).registerTicketWriteTools,
    (await import("./ticket-read.js")).registerTicketReadTools,
    (await import("./ticket-relations.js")).registerTicketRelationTools,
    (await import("./subscription.js")).registerSubscriptionTools,
    (await import("./inbox.js")).registerInboxTools,
    (await import("./upload.js")).registerUploadTools,
    (await import("./welcome.js")).registerWelcomeTools,
    (await import("./ticket-import.js")).registerTicketImportTool,
];

/** Every tool name the MCP server can register, captured without a server. */
function registeredNames(): string[] {
    const names: string[] = [];
    const fake = { registerTool: (name: string) => { names.push(name); } };
    for (const register of registrars) register(fake as never);
    return names;
}

test("every tool the MCP server can register has a declared audience", () => {
    const missing = registeredNames().filter((n) => !(n in TOOL_AUDIENCE));
    assert.deepEqual(missing, [], `declare who sees: ${missing.join(", ")}`);
});

test("the table names no tool that no longer exists", () => {
    const names = new Set(registeredNames());
    assert.deepEqual(Object.keys(TOOL_AUDIENCE).filter((k) => !names.has(k)), []);
});

test("the default type is shown every tool, exactly as before", () => {
    const hidden = registeredNames().filter((n) => !isToolVisible(n, "coder"));
    assert.deepEqual(hidden, []);
});

test("a gated server skips what the type is not shown, and registers the rest", () => {
    const table = { steer: ["cto"], build: ["coder"], shared: ["coder", "cto"] } as const;
    const run = (type: "coder" | "cto") => {
        const got: string[] = [];
        const server = gateServer({ registerTool: (name: string) => { got.push(name); } }, type, table);
        for (const name of ["steer", "build", "shared", "undeclared"]) server.registerTool(name);
        return got;
    };
    assert.deepEqual(run("coder"), ["build", "shared", "undeclared"]);
    assert.deepEqual(run("cto"), ["steer", "shared", "undeclared"]);
});

test("an unknown or missing type reads as the default, never as a narrower one", () => {
    for (const v of [undefined, null, "", "CTO", "lead", 42]) assert.equal(normalizeAgentType(v), "coder");
    assert.equal(normalizeAgentType("cto"), "cto");
});
