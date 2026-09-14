/**
 * #2454 — the files a payload travels through. What must hold:
 * - an env dump MERGES into an existing file: its keys are replaced in place or
 *   appended, every other line (comments, blank lines, other keys) is kept, a
 *   duplicate of a replaced key is dropped — it used to rewrite the whole file;
 * - a dump file is mode 0600, created or merged;
 * - a deposit file that is not a JSON object is refused WITHOUT quoting its
 *   content: a malformed secret file must not echo its own secret.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnv, readDepositFile, writeDumpFile } from "./payload-files.js";

const dir = mkdtempSync(join(tmpdir(), "payload-files-"));

test("an env merge replaces its keys in place and leaves everything else alone", () => {
    const existing = "# grumpy settings\nENGINE_KEY=keep-me\nBMS_M2M_IMAGE_KEY=old\n\nexport OTHER=1\nBMS_M2M_IMAGE_KEY=stale-duplicate\n";
    const merged = mergeEnv(existing, { BMS_M2M_IMAGE_KEY: "new", ADDED: "yes" });
    assert.equal(
        merged,
        "# grumpy settings\nENGINE_KEY=keep-me\nBMS_M2M_IMAGE_KEY=new\n\nexport OTHER=1\nADDED=yes\n",
    );
});

test("an `export KEY=` line keeps its export when replaced", () => {
    assert.equal(mergeEnv("export TOKEN=a\n", { TOKEN: "b" }), "export TOKEN=b\n");
});

test("an env dump into an existing file merges and tightens the mode; a new one is created 0600", () => {
    const existing = join(dir, "service.env");
    writeFileSync(existing, "ENGINE_KEY=keep-me\n", { mode: 0o644 });
    const written = writeDumpFile(existing, { BMS_M2M_IMAGE_KEY: "s3cr3t" }, "env");
    assert.equal(written.merged, true);
    assert.equal(readFileSync(existing, "utf8"), "ENGINE_KEY=keep-me\nBMS_M2M_IMAGE_KEY=s3cr3t\n", "the other key survived");
    assert.equal(statSync(existing).mode & 0o777, 0o600);

    const fresh = join(dir, "fresh.env");
    assert.equal(writeDumpFile(fresh, { A: "1" }, "env").merged, false);
    assert.equal(statSync(fresh).mode & 0o777, 0o600);
});

test("a malformed deposit file is refused without quoting its content", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ \"api_key\": sk-live-DO-NOT-ECHO-THIS }");
    assert.throws(() => readDepositFile(bad), (e: Error) => !e.message.includes("DO-NOT-ECHO") && /not valid JSON/.test(e.message));
    const arr = join(dir, "array.json");
    writeFileSync(arr, "[\"sk-live-DO-NOT-ECHO-THIS\"]");
    assert.throws(() => readDepositFile(arr), (e: Error) => !e.message.includes("DO-NOT-ECHO") && /JSON object/.test(e.message));
});
