/**
 * #3389 — a command typed in a folder that names its agent, from a shell
 * carrying another agent's identity, is refused: the rule, then the same
 * through the real launcher, from a folder holding a foreign `.aiball.yaml`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { judgeIdentity, takeAsFlag, type IdentityFacts } from "./identity-guard.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aiball-3389-")));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

const FOLDER = { file: "/w/wbox/.aiball.yaml", agent: "wbox-win", project: "wbox" };
const facts = (over: Partial<IdentityFacts>): IdentityFacts => ({
    command: "aiball", folder: FOLDER, envAgent: "aiball-win", envProject: "aiball",
    ownLoop: false, loopName: "cl-aiball-1", as: undefined, allow: false, ...over,
});

test("another agent's identity in a folder that names its own is refused, and says who is who", () => {
    const v = judgeIdentity(facts({}));
    assert.equal(v.kind, "refused");
    const msg = (v as { message: string }).message;
    assert.match(msg, /REFUSED — this folder is wbox-win's \(\/w\/wbox\/\.aiball\.yaml\)/);
    assert.match(msg, /this shell carries aiball-win \(AIBALL_AGENT, from the loop cl-aiball-1\)/);
    assert.match(msg, /--as aiball-win/);
});

test("the same agent under another project is refused too", () => {
    const v = judgeIdentity(facts({ envAgent: "wbox-win", envProject: "aiball" }));
    assert.equal(v.kind, "refused");
    assert.match((v as { message: string }).message, /the project aiball \(AIBALL_PROJECT.*\), not wbox/);
    assert.equal(judgeIdentity(facts({ envAgent: "wbox-win", envProject: "aiball", folder: { ...FOLDER, project: null } })).kind, "ok",
        "a folder that names no project has none to contradict");
});

test("not refused: no folder agent, the same identity, the loop's own folder, the script switch", () => {
    assert.equal(judgeIdentity(facts({ folder: null })).kind, "ok", "no .aiball.yaml: the environment decides");
    assert.equal(judgeIdentity(facts({ folder: { ...FOLDER, agent: null } })).kind, "ok", "a yaml naming no agent");
    assert.equal(judgeIdentity(facts({ envAgent: "wbox-win", envProject: "wbox" })).kind, "ok");
    assert.equal(judgeIdentity(facts({ envAgent: undefined, envProject: undefined })).kind, "ok", "a plain shell");
    assert.equal(judgeIdentity(facts({ ownLoop: true, envAgent: "wbox-crew" })).kind, "ok", "a crew agent of the loop running here");
    assert.equal(judgeIdentity(facts({ allow: true })).kind, "ok", "AIBALL_ALLOW_FOREIGN_AGENT=1");
});

test("--as passes when it names the agent the shell carries, and only then", () => {
    const ok = judgeIdentity(facts({ as: "aiball-win" }));
    assert.equal(ok.kind, "allowed");
    assert.match((ok as { warning: string }).warning, /acting as aiball-win .* in wbox-win's folder/);
    const wrong = judgeIdentity(facts({ as: "someone" }));
    assert.equal(wrong.kind, "refused");
    assert.match((wrong as { message: string }).message, /--as someone does not name the agent this shell carries, aiball-win/);
});

test("--as is taken out of the arguments, in both spellings, and not past `--`", () => {
    const a = ["node", "aiball", "ticket", "--as", "x", "list"];
    assert.equal(takeAsFlag(a), "x");
    assert.deepEqual(a, ["node", "aiball", "ticket", "list"]);
    const b = ["node", "aiball", "--as=y", "status"];
    assert.equal(takeAsFlag(b), "y");
    assert.deepEqual(b, ["node", "aiball", "status"]);
    const c = ["node", "aiball", "run", "--", "--as", "z"];
    assert.equal(takeAsFlag(c), undefined);
    assert.equal(c.length, 6);
});

// ---- through the real launcher, from a folder holding a foreign .aiball.yaml ----

const BIN = resolve(import.meta.dirname, "..", "bin");
const foreign = join(root, "wbox");
mkdirSync(join(foreign, "sub"), { recursive: true });
writeFileSync(join(foreign, ".aiball.yaml"), "consumer:\n  agent: wbox-win\n  project: wbox\n");
const bare = join(root, "bare");
mkdirSync(bare);

function run(bin: string, args: string[], cwd: string, env: Record<string, string | undefined> = {}) {
    const merged: NodeJS.ProcessEnv = { ...process.env, AIBALL_AGENT: "aiball-win", AIBALL_PROJECT: "aiball", ...env };
    // The suite's own switch (setup-isolation.ts): these tests are about the rule.
    if (!("AIBALL_ALLOW_FOREIGN_AGENT" in env)) delete merged.AIBALL_ALLOW_FOREIGN_AGENT;
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
    const r = spawnSync(process.execPath, [join(BIN, bin), ...args], { cwd, encoding: "utf8", env: merged });
    return { status: r.status, err: r.stderr, out: r.stdout };
}

test("launcher: refused in a foreign folder and below it, with both agents named", () => {
    for (const cwd of [foreign, join(foreign, "sub")]) {
        const r = run("claude-loop", ["list"], cwd);
        assert.equal(r.status, 2, r.err);
        assert.match(r.err, /claude-loop: REFUSED — this folder is wbox-win's/);
        assert.match(r.err, /this shell carries aiball-win/);
    }
    const a = run("aiball", ["status"], foreign);
    assert.equal(a.status, 2, a.err);
    assert.match(a.err, /aiball: REFUSED/);
});

test("launcher: --as the carried agent runs the command, with a warning; another name is refused", () => {
    const ok = run("claude-loop", ["list", "--as", "aiball-win"], foreign);
    assert.equal(ok.status, 0, ok.err);
    assert.match(ok.err, /acting as aiball-win/);
    assert.equal(run("claude-loop", ["--as=someone", "list"], foreign).status, 2);
});

test("launcher: not refused — the script switch, a folder without .aiball.yaml, the loop's own folder", () => {
    const sw = run("claude-loop", ["list"], foreign, { AIBALL_ALLOW_FOREIGN_AGENT: "1" });
    assert.equal(sw.status, 0, sw.err);
    assert.doesNotMatch(sw.err, /REFUSED|acting as/);
    assert.equal(run("claude-loop", ["list"], bare).status, 0, "no .aiball.yaml at or above it");
    // A crew agent's shell: its loop runs in this folder.
    const sd = join(root, "cl-wbox-crew");
    mkdirSync(sd);
    writeFileSync(join(sd, "plate.json"), JSON.stringify({ name: "cl-wbox-crew", cwd: foreign }));
    assert.equal(run("claude-loop", ["list"], join(foreign, "sub"), { AIBALL_AGENT: "wbox-crew", AIBALL_PROJECT: "wbox", CL_STATE_DIR: sd }).status, 0);
    // The same shell taken to another project's folder is refused there.
    const elsewhere = join(root, "other");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, ".aiball.yaml"), "consumer:\n  agent: other-win\n");
    const moved = run("claude-loop", ["list"], elsewhere, { AIBALL_AGENT: "wbox-crew", AIBALL_PROJECT: undefined, CL_STATE_DIR: sd });
    assert.equal(moved.status, 2, moved.err);
    assert.match(moved.err, /from the loop cl-wbox-crew/);
});

test("launcher: what reports rather than acts is not judged, nor `claude-loop start`", () => {
    assert.equal(run("aiball", ["--version"], foreign).status, 0);
    assert.doesNotMatch(run("aiball", ["--human", "status"], foreign).err, /REFUSED/, "--human acts as the moderator, not as the shell's agent");
    const start = run("claude-loop", ["start", "--cwd", "not-there"], foreign);
    assert.doesNotMatch(start.err + start.out, /REFUSED/);
    assert.match(start.err + start.out, /--cwd path does not exist/);
});
