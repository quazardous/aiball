/**
 * #3331 — the actionable sets live up to 10 min: a change to the YAML they read
 * (the claim window, the YAML automation rules) must empty them at once.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3331-cfg-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(home, "xdg");
mkdirSync(join(home, "xdg", "aiball"), { recursive: true });
const config = join(home, "xdg", "aiball", "config.yaml");
writeFileSync(config, "assign_window_sec: 3600\n");
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { computeActionableTicketIds } = await import("./projects.js");

upsertConsumer({ consumer_id: "worker", kind: "agent" });

test("a warm actionable set is served until the config file changes, then rebuilt", () => {
    const first = computeActionableTicketIds("worker");
    assert.equal(computeActionableTicketIds("worker"), first, "served from the cache");
    const later = new Date(Date.now() + 5000);
    utimesSync(config, later, later);
    assert.notEqual(computeActionableTicketIds("worker"), first, "rebuilt after the change");
});
