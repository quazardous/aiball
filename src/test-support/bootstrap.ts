// #324 test stack — bootstrap loaded via `--import` for `npm test`.
//
// node:test runs each `*.test.ts` in its OWN subprocess, so this module runs
// once per test file, BEFORE the file's imports resolve `getDb()`. It points
// `AIBALL_HOME` at a fresh temp dir → each test file gets a fully isolated,
// throwaway aiball DB. Env-only (the allowed mechanism, #fryynv) — zero
// test-conditionals in production code. The dir is removed on process exit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-test-"));
process.env.AIBALL_HOME = home;
process.on("exit", () => {
    try {
        rmSync(home, { recursive: true, force: true });
    } catch {
        /* best-effort cleanup */
    }
});
