// #2180 — init patches the identity into an EXISTING .aiball.yaml. A file
// without a consumer block (hand-written, or seeded by another tool) must get
// one, not crash on a block that was stored as a raw value.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { patchIdentity } from "./bootstrap.js";

const quietly = <T>(fn: () => T): T => {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try { return fn(); } finally { process.stdout.write = write; }
};

test("an existing .aiball.yaml WITHOUT a consumer block gets one, other keys and comments kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiball-identity-"));
    const path = join(dir, ".aiball.yaml");
    try {
        writeFileSync(path, "# hand-written\nautopoll:\n  enabled: true\n");
        quietly(() => patchIdentity(path, "cto", "p", undefined, "lead"));
        const y = parse(readFileSync(path, "utf8")) as { consumer: { agent: string; project: string; role: string }; autopoll: { enabled: boolean } };
        assert.deepEqual(y.consumer, { agent: "cto", project: "p", role: "lead" });
        assert.equal(y.autopoll.enabled, true);
        assert.match(readFileSync(path, "utf8"), /# hand-written/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
