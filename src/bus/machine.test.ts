/**
 * #3412 — where things run, in one vocabulary: a consumer's loop
 * (`consumer.list`), the caller (`bus.whoami`). A client behind a proxy node
 * compares the two instead of reading `remote`, which is the hub's view.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3412-"));
process.env.AIBALL_SOCK = "";
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { getMethod } = await import("./methods.js");
await import("./register.js");
const { testCaller } = await import("../tests/lib.js");
const { presenceConnect, __resetPresence } = await import("../live-presence.js");
const { machineName, setThisMachineForTests, thisMachine } = await import("../machine-name.js");

type Entry = { consumer_id: string; machine: string | null; remote: boolean };
const list = () => getMethod("consumer.list")!.run(testCaller("boss", { kind: "human" }), {} as never) as Entry[];
const whoami = (machine?: string) => (getMethod("bus.whoami")!.run({ ...testCaller("boss", { kind: "human" }), ...(machine ? { machine } : {}) }, {} as never) as { machine: string | null }).machine;

test("on the hub: its own loops are on `hub`, a node's on `node:<label>`, and the caller is named the same way", () => {
    setThisMachineForTests("hub");
    __resetPresence();
    upsertConsumer({ consumer_id: "boss", kind: "human" });
    for (const id of ["on-hub", "on-node", "direct", "no-loop"]) upsertConsumer({ consumer_id: id, kind: "agent" });
    presenceConnect("on-hub", "terminal", "local");
    presenceConnect("on-node", "terminal", "node:desk");
    presenceConnect("direct", "terminal", "tcp:10.0.0.7");
    const by = new Map(list().map((e) => [e.consumer_id, e.machine]));
    assert.equal(by.get("on-hub"), "hub");
    assert.equal(by.get("on-node"), "node:desk");
    assert.equal(by.get("direct"), "tcp:10.0.0.7");
    assert.equal(by.get("no-loop"), null, "no loop connected: no machine");

    assert.equal(whoami("local"), "hub", "a caller on the hub's own machine");
    assert.equal(whoami("node:desk"), "node:desk", "a caller behind the node: the machine of `on-node`, not of `on-hub`");
    assert.equal(whoami(), null, "a caller whose machine is not known");
});

test("on a node, `local` is the node: the word never goes out as it is", () => {
    setThisMachineForTests("node:desk");
    assert.equal(thisMachine(), "node:desk");
    assert.equal(machineName("local"), "node:desk");
    assert.equal(machineName("node:other"), "node:other");
    assert.equal(machineName(undefined), null);
    assert.equal(whoami("local"), "node:desk");
    setThisMachineForTests("hub");
});
