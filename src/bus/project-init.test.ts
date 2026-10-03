// #3208 — project.init: a folder set up as a project over the bus, as `claude-loop init` does, with its steps and its refusals as data.
import { test, after } from "node:test";
import { refused, testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3208-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const { getMethod } = await import("./methods.js");
await import("./register.js");
const { createProject } = await import("../db/projects.js");
after(() => rmSync(home, { recursive: true, force: true }));

const init = getMethod("project.init")!;
const human = testCaller("boss", { kind: "human" });
type Result = { steps: Array<{ file: string; action: string }>; written: string[]; kept: string[]; project_exists: boolean | null; skill: string };
const run = (p: Record<string, unknown>, caller = human) => init.run(caller, p) as Result;
let n = 0;
const folder = () => { const d = join(home, `f${n++}`); mkdirSync(d); return d; };

test("a fresh folder: both files written, the identity in the yaml, and whether the project is on the board", () => {
    const d = folder();
    const r = run({ cwd: d, project: "p-3208", agent: "a-3208", role: "crew", no_claim: true });
    assert.deepEqual(r.steps.map((s) => [s.file, s.action]), [[".mcp.json", "created"], [".aiball.yaml", "created"]]);
    assert.deepEqual([r.written, r.kept], [[".mcp.json", ".aiball.yaml"], []]);
    assert.equal(r.project_exists, false);
    assert.match(r.skill, /^(installed|missing)$/);
    assert.deepEqual(JSON.parse(readFileSync(join(d, ".mcp.json"), "utf8")).mcpServers.aiball, { command: "aiball-mcp" });
    assert.match(readFileSync(join(d, ".aiball.yaml"), "utf8"), /agent: a-3208\n  project: p-3208\n  no_claim: true\n  role: crew/);
    createProject({ name: "p-3208" });
    const again = run({ cwd: d, project: "p-3208" });
    assert.equal(again.project_exists, true, "a known project is not a refusal");
    assert.deepEqual(again.steps.map((s) => [s.file, s.action]), [[".mcp.json", "kept"], [".aiball.yaml", "patched"]]);
});

test("dry_run: the same answer, nothing written", () => {
    const d = folder();
    const r = run({ cwd: d, project: "p", agent: "a", dry_run: true });
    assert.deepEqual(r.written, [".mcp.json", ".aiball.yaml"]);
    assert.equal(existsSync(join(d, ".mcp.json")) || existsSync(join(d, ".aiball.yaml")), false);
});

test("refusals, with their code: no folder, a relative path, a malformed name, a file that cannot be parsed", async () => {
    assert.equal((await refused(() => run({ cwd: join(home, "none") }))).code, "NOT_FOUND");
    assert.equal((await refused(() => run({ cwd: "relative/dir" }))).code, "BAD_REQUEST");
    assert.equal((await refused(() => run({ cwd: folder(), project: "bad name!" }))).code, "BAD_REQUEST");
    const d = folder();
    writeFileSync(join(d, ".mcp.json"), "{nope");
    const r = await refused(() => run({ cwd: d }));
    assert.deepEqual([r.status, r.code], [409, "CONFLICT"]);
});

test("a folder the daemon may not write in: 403", { skip: process.getuid?.() === 0 ? "root writes everywhere" : false }, async () => {
    const d = folder();
    chmodSync(d, 0o555);
    try {
        const r = await refused(() => run({ cwd: d }));
        assert.deepEqual([r.status, r.code], [403, "FORBIDDEN"]);
    } finally {
        chmodSync(d, 0o755);
    }
});

test("a human's gesture on this machine: not over TCP", async () => {
    const tcp = testCaller("boss", { kind: "human", transport: "tcp" });
    assert.equal((await refused(() => run({ cwd: folder() }, tcp))).status, 403);
});

test("#3514 — each step says its facts as data, for a client that writes the line in its own language", () => {
    const d = folder();
    const r = run({ cwd: d, project: "p-3514", agent: "a-3514", private: true }) as unknown as { steps: Array<{ file: string; action: string; detail: Record<string, unknown> }> };
    assert.deepEqual(r.steps.map((s) => s.detail), [
        { path: join(d, ".mcp.json"), what: "mcp_entry" },
        { path: join(d, ".aiball.yaml"), what: "file", set: { "autopoll.enabled": true, project_type: "private", "consumer.agent": "a-3514", "consumer.project": "p-3514" } },
    ]);
    const again = run({ cwd: d, agent: "a-other" }) as unknown as { steps: Array<{ detail: Record<string, unknown> }> };
    assert.deepEqual(again.steps.map((s) => s.detail), [
        { path: join(d, ".mcp.json"), what: "mcp_entry", hint: "force" },
        { path: join(d, ".aiball.yaml"), what: "consumer", set: { "consumer.agent": "a-other" } },
    ]);
});
