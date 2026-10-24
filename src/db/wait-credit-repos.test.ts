/**
 * #4141 — a project's work may span a sibling repository (helios develops
 * egui-pop in `../egui-pop`): a commit cited from it earns once the folder's
 * `.aiball.yaml` names it in `repos:`, and nothing without.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4141-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("./connection.js");
const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { earnForCommits } = await import("./wait-credit.js");

const ROOT = mkdtempSync(join(tmpdir(), "aiball-4141-ws-"));
after(() => {
    for (const d of [process.env.AIBALL_HOME!, ROOT]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

function repoWithCommit(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const git = (args: string[]) => {
        const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim();
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    // The dir in the content: two repos committed in the same second would otherwise share the SHA.
    writeFileSync(join(dir, "f.txt"), Array.from({ length: 80 }, (_, i) => `${dir} line ${i}`).join("\n"));
    git(["add", "-A"]);
    git(["commit", "-qm", "c"]);
    return git(["rev-parse", "HEAD"]);
}

getDb();
upsertConsumer({ consumer_id: "w", kind: "agent" });
createProject({ name: "helios" });

const main = join(ROOT, "helios");
repoWithCommit(main);
const sibling = repoWithCommit(join(ROOT, "egui-pop"));

test("a sibling repository's commit earns nothing until repos: names it", () => {
    writeFileSync(join(main, ".aiball.yaml"), "consumer:\n  project: helios\n");
    const [r] = earnForCommits("w", "helios", 1, main, [sibling]);
    assert.equal(r.minutes, 0);
    assert.match(r.reason ?? "", /not a commit in/);
});

test("named in repos: (relative to the folder), it earns", () => {
    writeFileSync(join(main, ".aiball.yaml"), "consumer:\n  project: helios\nrepos:\n  - ../egui-pop\n  - ../gone\n");
    const [r] = earnForCommits("w", "helios", 2, main, [sibling]);
    assert.ok(r.minutes > 0, JSON.stringify(r));
    assert.equal(r.reason, null);
});
