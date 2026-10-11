// #3765 — project.rename_all: `aiball project rename-all` on the bus, on a fake machine only (HOME, Claude's state and the loops under a temp dir).
import { test, after } from "node:test";
import { refused, testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "aiball-3765-")));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, ".claude-loop");
const { getMethod } = await import("./methods.js");
await import("./register.js");
const { createProject, listProjects, upsertConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { getDb } = await import("../db/connection.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");
after(() => rmSync(home, { recursive: true, force: true }));

const renameAll = getMethod("project.rename_all")!;
const human = testCaller("boss", { kind: "human" });
upsertConsumer({ consumer_id: "boss", kind: "human" });

/** A project with a ticket, its folder, and its loop's pushed root. */
function project(name: string, roots: string[]) {
    createProject({ name });
    submitMessage({ project: name, kind: "ticket_created", title: "t", body: "b", by_agent: "boss" });
    roots.forEach((root, i) => {
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, ".aiball.yaml"), `consumer:\n  project: ${name}\n`);
        const agent = `${name}-agent-${i}`;
        upsertConsumer({ consumer_id: agent, kind: "agent" });
        getDb().update(schema.consumers).set({ project: name, cwd: root }).where(eq(schema.consumers.consumerId, agent)).run();
    });
}
const cwdOf = (agent: string) => getDb().select({ cwd: schema.consumers.cwd }).from(schema.consumers).where(eq(schema.consumers.consumerId, agent)).get()?.cwd;
type Answer = { applied: boolean; plan: { db: string; folder: { from: string; to: string } | null }; blockers: Array<{ kind: string; text: string; loop?: string }> };
const run = (p: Record<string, unknown>, caller = human) => renameAll.run(caller, p) as Promise<Answer>;

test("the dry run plans from the project's known folder and changes nothing; apply renames, moves, and the root follows", async () => {
    const dir = join(home, "projects", "alpha");
    project("alpha", [dir]);
    const dry = await run({ name: "alpha", new_name: "beta" });
    assert.deepEqual([dry.applied, dry.blockers, dry.plan.db, dry.plan.folder?.from, dry.plan.folder?.to], [false, [], "rename", dir, join(home, "projects", "beta")]);
    assert.ok(listProjects().includes("alpha") && existsSync(dir), "a dry run changes nothing");
    const done = await run({ name: "alpha", new_name: "beta", apply: true });
    assert.equal(done.applied, true);
    assert.ok(listProjects().includes("beta") && !listProjects().includes("alpha"));
    const moved = join(home, "projects", "beta");
    assert.ok(!existsSync(dir) && existsSync(moved));
    assert.match(readFileSync(join(moved, ".aiball.yaml"), "utf8"), /project: beta/);
    assert.equal(cwdOf("alpha-agent-0"), moved, "the root the loop pushed follows the folder");
});

test("blockers come as data: a running loop names itself, beside the sentence the CLI prints", async () => {
    const dir = join(home, "projects", "gamma");
    project("gamma", [dir]);
    const loop = join(home, ".claude-loop", "cl-gamma");
    mkdirSync(loop, { recursive: true });
    writeFileSync(join(loop, "plate.json"), JSON.stringify({ name: "cl-gamma", cwd: dir }));
    writeFileSync(join(loop, "loop.pid"), String(process.pid));
    const r = await run({ name: "gamma", new_name: "delta", apply: true });
    assert.equal(r.applied, false, "nothing applied while a blocker stands");
    assert.deepEqual(r.blockers.map((b) => [b.kind, b.loop]), [["loop", "cl-gamma"]]);
    assert.match(r.blockers[0].text, /loop cl-gamma is running/);
    assert.ok(listProjects().includes("gamma") && existsSync(dir), "nothing renamed, nothing moved");
    const taken = await run({ name: "gamma", new_name: "beta", no_move: true });
    assert.deepEqual(taken.blockers.map((b) => b.kind), ["name"]);
});

test("no known folder, or several: refused with the roots as data; cwd names it", async () => {
    createProject({ name: "rootless" });
    submitMessage({ project: "rootless", kind: "ticket_created", title: "t", body: "b", by_agent: "boss" });
    const none = await refused(run({ name: "rootless", new_name: "x" }));
    assert.deepEqual([none.code, (none as { details?: unknown }).details], ["NO_ROOT", { roots: [] }]);
    const a = join(home, "two", "a");
    const b = join(home, "two", "b");
    project("two", [a, b]);
    const several = await refused(run({ name: "two", new_name: "three" }));
    assert.equal(several.code, "AMBIGUOUS_ROOT");
    assert.deepEqual(((several as { details?: { roots: string[] } }).details?.roots ?? []).sort(), [a, b]);
    const named = await run({ name: "two", new_name: "three", cwd: a, dir: join(home, "two", "three") });
    assert.deepEqual(named.blockers, []);
    assert.equal(named.plan.folder?.from, a);
});

test("a human's gesture on this machine: humans only, a remote caller and a relative path refused", async () => {
    assert.deepEqual(renameAll.who, ["human"], "the bus refuses an agent before the method runs");
    assert.equal((await refused(run({ name: "beta", new_name: "z" }, testCaller("boss", { kind: "human", transport: "tcp" })))).status, 403);
    assert.equal((await refused(run({ name: "beta", new_name: "z", cwd: "projects/beta" }))).status, 400);
});
