// #3138 — a file's durations: the notation or seconds under the new names, and
// for one version the old names, read, converted, and reported to be renamed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aiball-3138-"));
process.env.XDG_CONFIG_HOME = join(root, "xdg");
mkdirSync(join(root, "xdg", "aiball"), { recursive: true });
const { loadConfig } = await import("./config.js");
const { readFileValue } = await import("../config/file-reader.js");
after(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, yaml: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".aiball.yaml"), yaml);
    return dir;
}

test("autopoll.throttle takes the notation or seconds; recent_tickets its new name", () => {
    const cfg = loadConfig(project("new", "autopoll:\n  throttle: 2m\n  recent_tickets: 5\n"));
    assert.equal(cfg.autopoll.throttle, 120);
    assert.equal(cfg.autopoll.recent_tickets, 5);
    assert.deepEqual(cfg.renamed_keys, []);
    assert.equal(loadConfig(project("secs", "autopoll:\n  throttle: 45\n")).autopoll.throttle, 45);
});

test("the old names still read, for one version, and are reported to be renamed", () => {
    const cfg = loadConfig(project("old", "autopoll:\n  throttle_seconds: 30\n  include_recent_tickets: 2\n"));
    assert.equal(cfg.autopoll.throttle, 30);
    assert.equal(cfg.autopoll.recent_tickets, 2);
    assert.deepEqual(cfg.renamed_keys, ["autopoll.throttle_seconds → autopoll.throttle", "autopoll.include_recent_tickets → autopoll.recent_tickets"]);
});

test("both spellings: the new one wins", () => {
    assert.equal(loadConfig(project("both", "autopoll:\n  throttle: 1m\n  throttle_seconds: 999\n")).autopoll.throttle, 60);
});

test("the managed read of a file key falls back to its old name, converted", () => {
    const dir = project("managed", "autopoll:\n  throttle_seconds: 90\n");
    assert.equal(readFileValue("project", "autopoll.throttle", dir), 90);
    const dir2 = project("managed2", "autopoll:\n  throttle: 1h\n");
    assert.equal(readFileValue("project", "autopoll.throttle", dir2), 3600);
});
