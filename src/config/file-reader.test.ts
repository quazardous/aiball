// #590 phase 2 — pure I/O tests for the generic FILE config reader.
// Uses tmpdir + a fixture .aiball.yaml ; no daemon, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileValue, _resetFileCache } from "./file-reader.js";

function fixtureCwd(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "aiball-590-"));
    writeFileSync(join(dir, ".aiball.yaml"), yaml);
    _resetFileCache();
    return dir;
}

test("readFileValue: missing project file → undefined", () => {
    _resetFileCache();
    const empty = mkdtempSync(join(tmpdir(), "aiball-590-empty-"));
    assert.equal(readFileValue("project", "tickets.default_priority", empty), undefined);
});

test("readFileValue: unknown key → undefined (not in schema)", () => {
    const cwd = fixtureCwd("autopoll:\n  tone: imperative\n");
    assert.equal(readFileValue("project", "unknown.bogus.key", cwd), undefined);
});

test("readFileValue: key present but absent in YAML → undefined", () => {
    const cwd = fixtureCwd("autopoll:\n  tone: imperative\n");
    // tickets.default_priority IS a schema key, but not in this YAML.
    assert.equal(readFileValue("project", "tickets.default_priority", cwd), undefined);
});

test("readFileValue: dotted path walked, value coerced for schema-known key", () => {
    // tickets.default_priority is the only schema-known key as of phase 1
    // (no FILE-source keys exist yet). The reader still walks the path and
    // coerces against the enum.
    const cwd = fixtureCwd("tickets:\n  default_priority: high\n");
    assert.equal(readFileValue("project", "tickets.default_priority", cwd), "high");
});

test("readFileValue: invalid value (off-enum) → undefined", () => {
    const cwd = fixtureCwd("tickets:\n  default_priority: nope\n");
    assert.equal(readFileValue("project", "tickets.default_priority", cwd), undefined);
});

test("readFileValue: project layer no cwd → undefined (path can't resolve)", () => {
    assert.equal(readFileValue("project", "tickets.default_priority"), undefined);
});

test("readFileValue: walks up from sub-dir to find .aiball.yaml", () => {
    const root = fixtureCwd("tickets:\n  default_priority: urgent\n");
    const sub = join(root, "sub", "deep");
    mkdirSync(sub, { recursive: true });
    _resetFileCache();
    assert.equal(readFileValue("project", "tickets.default_priority", sub), "urgent");
});

test("readFileValue: re-read picks up mtime changes (cache invalidation)", () => {
    const cwd = fixtureCwd("tickets:\n  default_priority: low\n");
    assert.equal(readFileValue("project", "tickets.default_priority", cwd), "low");
    // Wait a tick so mtime differs, then rewrite.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    return sleep(20).then(() => {
        writeFileSync(join(cwd, ".aiball.yaml"), "tickets:\n  default_priority: urgent\n");
        assert.equal(readFileValue("project", "tickets.default_priority", cwd), "urgent");
    });
});
