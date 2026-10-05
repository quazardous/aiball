/**
 * #3611 — an agent's session starts at its last size, not 80×24: the daemon
 * keeps the size its host had when it stopped (and when a client left), and
 * starts the next host at it; a size given wins.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { sessionHostSkip } from "../tests/session-host-bin.js";

const home = mkdtempSync("/tmp/aiball-3611-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const { rememberSize, rememberedSize } = await import("./session-sizes.js");
const { startSession, stopSession } = await import("./registry.js");
after(() => rmSync(home, { recursive: true, force: true }));

test("kept by agent; a size out of reason is ignored", () => {
    assert.equal(rememberedSize("a-one"), null);
    rememberSize("a-one", { rows: 59, cols: 152 });
    assert.deepEqual(rememberedSize("a-one"), { rows: 59, cols: 152 });
    rememberSize("a-one", { rows: 2, cols: 152 });
    rememberSize("a-one", { rows: 59, cols: "152" });
    assert.deepEqual(rememberedSize("a-one"), { rows: 59, cols: 152 }, "nonsense keeps the last good one");
    assert.equal(rememberedSize("someone-else"), null);
});

const skip = sessionHostSkip();

test("a real host: stopped at 152×59, the next start without a size comes back at 152×59; a size given wins", { skip }, async () => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const first = await startSession({ agent: "sized", argv: ["sh", "-c", "sleep 30"], cwd: home, env, size: { rows: 59, cols: 152 } });
    await stopSession(first);
    assert.deepEqual(rememberedSize("sized"), { rows: 59, cols: 152 }, "kept as it stopped");
    const again = await startSession({ agent: "sized", argv: ["sh", "-c", "sleep 30"], cwd: home, env });
    assert.deepEqual((await again.call<{ size: unknown }>("host.hello")).size, { rows: 59, cols: 152 }, "not 80×24");
    await stopSession(again);
    const given = await startSession({ agent: "sized", argv: ["sh", "-c", "sleep 30"], cwd: home, env, size: { rows: 40, cols: 100 } });
    assert.deepEqual((await given.call<{ size: unknown }>("host.hello")).size, { rows: 40, cols: 100 });
    await stopSession(given);
});
