/**
 * #3065 — a balance never goes over `tickets.wait_credit_max_minutes` (120 by
 * default, per project, 0 = no cap): a gain is cut to what fits, a balance
 * already over is cut back once, and a commit earning nothing at the cap says
 * why.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3065-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("./connection.js");
const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { setConfigOverride } = await import("./config-overrides.js");
const { waitCreditBalance, earnOnClose, earnForCommits, listWaitCredits, roomUnderCap, waitCreditRules } = await import("./wait-credit.js");
const { sql } = await import("drizzle-orm");

const REPO = mkdtempSync(join(tmpdir(), "aiball-3065-repo-"));
after(() => {
    for (const d of [process.env.AIBALL_HOME!, REPO]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

getDb();
upsertConsumer({ consumer_id: "w", kind: "agent" });

/** A gain from before the cap existed: straight into the ledger. */
function legacyGain(project: string, minutes: number): void {
    getDb().run(sql`INSERT INTO wait_credit_moves (consumer_id, project, kind, minutes, created_at) VALUES ('w', ${project}, 'earn_resolved', ${minutes}, ${new Date().toISOString()})`);
}
const moves = (project: string, kind: string) => getDb().all<{ minutes: number }>(sql`SELECT minutes FROM wait_credit_moves WHERE consumer_id = 'w' AND project = ${project} AND kind = ${kind}`);

test("pure: the room under the cap; 0 is no cap", () => {
    assert.equal(roomUnderCap(100, 120), 20);
    assert.equal(roomUnderCap(130, 120), 0);
    assert.equal(roomUnderCap(5000, 0), Infinity);
});

test("a balance over the cap is cut back to it, once, and listed at it", () => {
    createProject({ name: "p-over" });
    legacyGain("p-over", 1185); // 60 + 1185 = 1245
    assert.equal(waitCreditBalance("w", "p-over"), 120);
    assert.equal(waitCreditBalance("w", "p-over"), 120);
    assert.deepEqual(moves("p-over", "cap"), [{ minutes: -1125 }], "one cap move, not one per read");
    assert.equal(listWaitCredits("p-over")[0].balance, 120);
});

test("a gain is cut to what fits under the cap, and at the cap it earns nothing, once", () => {
    createProject({ name: "p-gain" });
    legacyGain("p-gain", 50); // 110
    assert.equal(earnOnClose("w", "p-gain", 1, "resolved"), 10, "10 of the 10 fit (no commit)");
    assert.equal(waitCreditBalance("w", "p-gain"), 120);
    assert.equal(earnOnClose("w", "p-gain", 2, "wontfix"), 0, "at the cap: nothing");
    assert.equal(waitCreditBalance("w", "p-gain"), 120);
    assert.equal(earnOnClose("w", "p-gain", 2, "wontfix"), 0);
    assert.equal(moves("p-gain", "earn_wontfix").length, 1, "the ticket earned its once, at 0");
});

test("the cap is a per-project setting; 0 lifts it", () => {
    createProject({ name: "p-free" });
    setConfigOverride("p-free", "tickets.wait_credit_max_minutes", 0);
    legacyGain("p-free", 1000);
    assert.equal(waitCreditBalance("w", "p-free"), 1060);
    assert.equal(waitCreditRules("p-free").max, 0);
    createProject({ name: "p-low" });
    setConfigOverride("p-low", "tickets.wait_credit_max_minutes", 30);
    assert.equal(waitCreditBalance("w", "p-low"), 30, "a cap under the start cuts the start too");
    assert.equal(waitCreditRules("p-low").max, 30);
});

test("a commit cited at the cap earns nothing, says why, and can still earn once there is room", () => {
    const git = (args: string[]) => {
        const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim();
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(REPO, "a.txt"), Array.from({ length: 100 }, (_, i) => `l ${i}`).join("\n") + "\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "c"]);
    const sha = git(["rev-parse", "HEAD"]);

    createProject({ name: "p-commit" });
    legacyGain("p-commit", 60); // 120, at the cap
    const [atCap] = earnForCommits("w", "p-commit", 1, REPO, [sha]);
    assert.deepEqual(atCap, { commit: sha, minutes: 0, reason: "your wait credit is at its cap, 120 min" });
    legacyGain("p-commit", -3); // 117
    const [some] = earnForCommits("w", "p-commit", 1, REPO, [sha]);
    assert.deepEqual(some, { commit: sha, minutes: 3, reason: null }, "5 earned, 3 fit");
    assert.equal(waitCreditBalance("w", "p-commit"), 120);
});
