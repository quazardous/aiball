/**
 * The kernel's start-up code logs when it takes the loop over from an older
 * kernel. Its logger is a `const`: declared further down the module, that line
 * threw "Cannot access 'logger' before initialization" and the new kernel died
 * at boot — after it had killed the old one, so the loop was left with none.
 * It only happened when there WAS an older kernel to kill (a reload crossing
 * another), which no test boots into: so the order is checked on the source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "kernel.ts"), "utf8");

test("the kernel's logger is declared before the start-up code that logs", () => {
    const declared = src.indexOf("const logger = createLogger(");
    assert.ok(declared > 0, "the logger's declaration was not found: update this test with its new form");
    // The top-level statements that run at import and may call log().
    for (const first of ["const claimed = claimLoopAsKernel(", "function cleanShutdown("]) {
        const at = src.indexOf(first);
        assert.ok(at > 0, `${first} was not found: update this test`);
        assert.ok(declared < at, `\`${first}…\` runs or is reachable before the logger is declared`);
    }
});
