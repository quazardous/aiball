/**
 * #4867 — what a node answers while cut from its master: the reads it lists are
 * real methods, and none of them is one that writes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-4867-cut-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { getMethod } = await import("./bus/methods.js");
await import("./bus/register.js");
const { CUT_READS, storeFile, missingFiles } = await import("./replica-node.js");
const { UPLOADS_DIR } = await import("./paths.js");
const { getRawSqlite } = await import("./db.js");
const { createHash } = await import("node:crypto");
const { existsSync } = await import("node:fs");

test("each read a cut node answers is a method of the bus", () => {
    assert.deepEqual([...CUT_READS].filter((m) => !getMethod(m)), []);
});

test("none of them is a write", () => {
    const writes = /\\.(post|set_|mark|decide|delete|create|update|assign|subscribe$|unsubscribe$|vote|edit)/;
    assert.deepEqual([...CUT_READS].filter((m) => !m.startsWith("bus.") && writes.test(m)), []);
});

test("#4873 an attachment's file is kept only when its content is its name", () => {
    const content = Buffer.from("a picture");
    const sha = createHash("sha256").update(content).digest("hex");
    getRawSqlite().prepare(`INSERT INTO uploads (sha, ext, content_type, bytes, created_at) VALUES (?, 'png', 'image/png', ?, ?)`).run(sha, content.length, new Date().toISOString());
    assert.deepEqual(missingFiles().map((f) => f.sha), [sha], "listed, not here");
    assert.equal(storeFile(sha, "png", Buffer.from("something else")), false, "a content that is not its name is refused");
    assert.equal(existsSync(join(UPLOADS_DIR, `${sha}.png`)), false);
    assert.equal(storeFile(sha, "png", content), true);
    assert.deepEqual(missingFiles(), [], "here now");
});
