// #2180 — `start --init --cwd X` must write into X even when the shell exports
// AIBALL_CWD, which every loop session does. Without this it wrote into the
// loop's own repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withInitCwd } from "./init-cwd.js";
import { userCwd } from "../cli/_helpers.js";

const target = () => realpathSync(mkdtempSync(join(tmpdir(), "aiball-initcwd-")));

test("inside, init sees the target even when AIBALL_CWD points elsewhere; after, both are restored", async () => {
    const dir = target();
    const before = process.cwd();
    process.env.AIBALL_CWD = "/somewhere/else";
    try {
        const seen = await withInitCwd(dir, async () => userCwd());
        assert.equal(seen, dir);
        assert.equal(process.env.AIBALL_CWD, "/somewhere/else");
        assert.equal(process.cwd(), before);
    } finally {
        delete process.env.AIBALL_CWD;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an unset AIBALL_CWD stays unset afterwards", async () => {
    const dir = target();
    delete process.env.AIBALL_CWD;
    try {
        assert.equal(await withInitCwd(dir, async () => userCwd()), dir);
        assert.equal(Object.prototype.hasOwnProperty.call(process.env, "AIBALL_CWD"), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a failing init still restores the directory and the variable", async () => {
    const dir = target();
    const before = process.cwd();
    process.env.AIBALL_CWD = "/somewhere/else";
    try {
        await assert.rejects(withInitCwd(dir, async () => { throw new Error("boom"); }), /boom/);
        assert.equal(process.cwd(), before);
        assert.equal(process.env.AIBALL_CWD, "/somewhere/else");
    } finally {
        delete process.env.AIBALL_CWD;
        rmSync(dir, { recursive: true, force: true });
    }
});
