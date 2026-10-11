// #3765 — the rename's child loads its TypeScript however the daemon was started: by `tsx watch` (the loader in
// its flags) or by bin/aiball-daemon (tsx registered in process, nothing in its flags).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { childExecArgv } from "./project-rename-worker.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aiball-3765w-")));
after(() => rmSync(root, { recursive: true, force: true }));

test("a parent started as bin/aiball-daemon starts it (tsx registered in process): the child still plans", () => {
    const dir = join(root, "p", "alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".aiball.yaml"), "consumer:\n  project: alpha\n");
    const worker = fileURLToPath(new URL("./project-rename-worker.ts", import.meta.url));
    const script = `
        const { register } = await import("tsx/esm/api");
        register();
        const { inWorker } = await import(${JSON.stringify(worker)});
        const plan = await inWorker({ op: "plan", input: { oldName: "alpha", newName: "beta", from: ${JSON.stringify(dir)} }, names: ["alpha"],
            paths: { claudeDir: ${JSON.stringify(join(root, ".claude"))}, claudeJson: ${JSON.stringify(join(root, ".claude.json"))}, loopRoot: ${JSON.stringify(join(root, "loops"))}, scanRoots: [] } });
        process.stdout.write(JSON.stringify({ db: plan.db, to: plan.relocate?.new, blockers: plan.blockers.length }));
        process.exit(0);
    `;
    // Bare flags, as the launcher's daemon has them: no tsx anywhere. The script sits in the checkout, so it finds tsx.
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const file = join(repo, `.tmp-3765-launcher-${process.pid}.mjs`);
    writeFileSync(file, script);
    let r;
    try { r = spawnSync(process.execPath, [file], { cwd: repo, encoding: "utf8", timeout: 60_000 }); } finally { rmSync(file, { force: true }); }
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { db: "rename", to: join(root, "p", "beta"), blockers: 0 });
});

test("childExecArgv: the parent's flags, tsx's loader added only when they lack it", () => {
    assert.deepEqual(childExecArgv(["--import", "file:///x/tsx/dist/loader.mjs"], "L"), ["--import", "file:///x/tsx/dist/loader.mjs"]);
    assert.deepEqual(childExecArgv(["--max-old-space-size=99"], "L"), ["--max-old-space-size=99", "--import", "L"]);
});
