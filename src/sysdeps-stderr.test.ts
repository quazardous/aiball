/**
 * Which line of a stderr dump `aiball check` shows for a broken shim.
 *
 * Reported from Windows: the check named `node:internal/modules/cjs/loader:1451`
 * — the loader's own header — instead of "cannot find module". The feature
 * exists to make a mute failure legible, so it was failing at its one job while
 * looking like it worked.
 *
 * The dumps below are real: produced by running node against a missing file.
 *
 * Run: `npx tsx --test src/sysdeps-stderr.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstUsefulStderrLine } from "./sysdeps.js";

/** Verbatim from `node <missing-file>` — the shape a dead shim produces. */
const NODE_MISSING_MODULE = [
    "node:internal/modules/cjs/loader:1386",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module '/opt/aiball/bin/aiball'",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1383:15)",
    "    at defaultResolveImpl (node:internal/modules/cjs/loader:1025:19)",
].join("\n");

test("a dead node shim names the module, not the loader — the reported bug", () => {
    assert.equal(
        firstUsefulStderrLine(NODE_MISSING_MODULE),
        "Error: Cannot find module '/opt/aiball/bin/aiball'",
    );
});

test("a stack frame is never the answer", () => {
    // Skipping the header but landing on `at Module._resolveFilename` would be
    // the same failure one line over.
    const out = firstUsefulStderrLine(NODE_MISSING_MODULE);
    assert.ok(out && !out.startsWith("at "), `picked a stack frame: ${out}`);
});

test("other error classes are recognised, not just `Error`", () => {
    assert.equal(
        firstUsefulStderrLine("node:internal/x:1\nTypeError: foo is not a function\n    at bar"),
        "TypeError: foo is not a function",
    );
    assert.equal(
        firstUsefulStderrLine("SyntaxError: Unexpected token"),
        "SyntaxError: Unexpected token",
    );
});

test("a plain message with no error class still comes through", () => {
    // A .cmd shim on Windows fails without any Node involvement at all.
    assert.equal(
        firstUsefulStderrLine("Le chemin d'accès spécifié est introuvable."),
        "Le chemin d'accès spécifié est introuvable.",
    );
});

test("scaffolding only: something is returned rather than nothing", () => {
    // A shape nobody anticipated must not silently degrade to "no detail" —
    // that is the mute failure this whole feature replaces.
    assert.equal(firstUsefulStderrLine("  at foo\n  at bar"), "at foo");
});

test("empty stderr yields undefined so the caller can say `exited N`", () => {
    assert.equal(firstUsefulStderrLine(""), undefined);
    assert.equal(firstUsefulStderrLine("\n  \n\n"), undefined);
});
