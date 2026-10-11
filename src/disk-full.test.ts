// #3774 — a full disk loses a write, not the process; any other error still ends it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDiskFull } from "./disk-full.js";

const guard = fileURLToPath(new URL("./disk-full.ts", import.meta.url));
/** A child that installs the guard, throws `code` from a timer, then says whether it lived on. */
function child(code: string) {
    const script = `
        const { surviveDiskFull } = await import(${JSON.stringify(guard)});
        surviveDiskFull("test");
        setTimeout(() => { throw Object.assign(new Error("boom"), { code: ${JSON.stringify(code)} }); }, 5);
        setTimeout(() => { process.stdout.write("alive"); process.exit(0); }, 60);
    `;
    return spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
}

test("SQLITE_FULL and ENOSPC from a timer: warned once on stderr, the process lives on", () => {
    for (const code of ["SQLITE_FULL", "ENOSPC"]) {
        const r = child(code);
        assert.equal(r.status, 0, `${code}: ${r.stderr}`);
        assert.equal(r.stdout, "alive");
        assert.match(r.stderr, /disk full, a write was lost: boom/);
    }
});

test("any other uncaught error still ends the process, its stack said", () => {
    const r = child("EACCES");
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /boom/);
});

test("isDiskFull: the disk, a quota, SQLite's own; nothing else", () => {
    for (const code of ["ENOSPC", "EDQUOT", "SQLITE_FULL"]) assert.ok(isDiskFull({ code }));
    for (const e of [{ code: "EACCES" }, new Error("x"), null, "ENOSPC"]) assert.ok(!isDiskFull(e));
});
