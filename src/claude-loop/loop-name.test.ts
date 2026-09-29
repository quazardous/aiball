// #3338 — a loop's name comes from the folder it runs in, never the shell's.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopName } from "./loop-name.js";

const root = mkdtempSync(join(tmpdir(), "aiball-3338-"));
after(() => rmSync(root, { recursive: true, force: true }));
const hash = (cwd: string, agent: string) => createHash("sha256").update(`${cwd}:${agent}`).digest("hex").slice(0, 6);

test("the name is the loop folder's and agent's hash, whatever the shell's folder", () => {
    const tvty = join(root, "tvty");
    const saved = process.cwd();
    try {
        process.chdir(root);
        assert.equal(loopName({ project: "tvty", agent: "tvty-claude", cwd: tvty }), `cl-tvty-${hash(tvty, "tvty-claude")}`);
    } finally {
        process.chdir(saved);
    }
});

test("a folder reached through a symlink gets the same name; no agent and no project still name a loop", () => {
    const real = mkdtempSync(join(root, "real-"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    assert.equal(loopName({ project: "p", agent: "a", cwd: link }), loopName({ project: "p", agent: "a", cwd: real }));
    assert.match(loopName({ cwd: real }), /^cl-loop-[0-9a-f]{6}$/);
    assert.equal(loopName({ project: "my proj!", agent: "a", cwd: real }).startsWith("cl-my-proj-"), true);
});
