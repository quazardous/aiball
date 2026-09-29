// #3299 — `aiball drain` touches `.drain-trigger` in the spool dir: the daemon's
// watcher drains on it, though it never reads that file as a spooled write.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3299-drain-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const { SPOOL_DIR, ensureDirs } = await import("./paths.js");
const { upsertConsumer } = await import("./db.js");
const { getDb } = await import("./db/connection.js");
const { createProject } = await import("./db/projects.js");
const { submitMessage } = await import("./messages.js");
const { watchSpool, DRAIN_TRIGGER } = await import("./spool.js");
after(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows may hold the db */ } });

getDb(); ensureDirs();
upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "p-3299" });
const ticket = submitMessage({ project: "p-3299", kind: "ticket_created", title: "t", body: "b", by_agent: "boss" }).id;

const spooled = () => readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json"));

test("touching the drain trigger drains a write already waiting in the spool", async () => {
    // Spooled before the watcher runs, so only the trigger can wake it.
    writeFileSync(join(SPOOL_DIR, "1-0.json"), JSON.stringify({
        project: "p-3299", kind: "comment_added", ticket_id: ticket, body: "waiting", by_agent: "boss",
    }));
    const w = watchSpool();
    try {
        await new Promise((r) => setTimeout(r, 100));
        assert.deepEqual(spooled(), ["1-0.json"], "nothing drains it on its own");
        const marker = join(SPOOL_DIR, DRAIN_TRIGGER);
        writeFileSync(marker, "");
        unlinkSync(marker);
        const until = Date.now() + 3_000;
        while (spooled().length > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(spooled(), [], "the trigger drained it");
    } finally {
        w.close();
    }
});
