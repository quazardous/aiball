/**
 * #2333 — a message to every agent loop before the operator leaves.
 * What must hold, over the bus:
 * - only a moderator may send it, hold or release loops, the per-agent AFK method included;
 * - it reaches the agent loops connected now, not humans nor loops that are gone;
 * - "send" types the message and leaves the loops alone;
 * - "send & hold" also sends NOT AFK ∞ down each loop's socket, and says which
 *   loop could not be held;
 * - "release holds" sends the release down the same socket.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2333-"));
process.env.AIBALL_SOCK = "";
const LOOPS = mkdtempSync(join(tmpdir(), "cl-2333-"));
process.env.CLAUDE_LOOP_STATE_ROOT = LOOPS;

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, setConsumerState } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { presenceConnect } = await import("../live-presence.js");
const { onControl } = await import("../event-bus.js");
const { listenEvents } = await import("../claude-loop/ipc-events.js");
const { loopSockPath } = await import("../claude-loop/state.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
for (const id of ["held", "no-loop", "offline"]) upsertConsumer({ consumer_id: id, kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2333-h" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "held", label: "2333-a" }).token;

// "held" has a real loop listening on its socket; "no-loop" is connected but its
// loop dir cannot be found; "offline" has no loop connected.
presenceConnect("boss");
presenceConnect("held");
presenceConnect("no-loop");
setConsumerState("held", "idle", undefined, undefined, "/work/held");
setConsumerState("no-loop", "idle", undefined, undefined, "/work/no-loop");
const sd = join(LOOPS, "cl-held");
mkdirSync(sd);
writeFileSync(join(sd, "plate.json"), JSON.stringify({ cwd: "/work/held" }));
const markers: string[] = [];
const loop = listenEvents(loopSockPath(sd), (ev) => {
    const data = ev.data as { name?: string } | undefined;
    if (ev.kind === "proxyEvent" && data?.name) markers.push(data.name);
});

const prompts: Record<string, string[]> = { boss: [], held: [], "no-loop": [], offline: [] };
for (const id of Object.keys(prompts)) {
    onControl(id, (p) => { if (p.action === "prompt") prompts[id]!.push(p.text); });
}

after(() => {
    loop.close();
    for (const d of [process.env.AIBALL_HOME!, LOOPS]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

type Result = { consumer_id: string; prompt?: string; hold?: string; hold_error?: string };

function post(method: string, params: Record<string, unknown>, token = HUMAN): Promise<{ status: number; json: { error?: string; results?: Result[] } }> {
    return asToken(token, method, params);
}

async function nextMarker(count: number): Promise<string[]> {
    for (let i = 0; i < 100 && markers.length < count; i++) await new Promise((r) => setTimeout(r, 20));
    return [...markers];
}

test("only a moderator sends, holds or releases", async () => {
    assert.equal((await post("loops.message_all", { message: "x", hold: true }, AGENT)).status, 403);
    assert.equal((await post("loops.release_all", {}, AGENT)).status, 403);
    assert.equal((await post("consumer.afk", { name: "held", action: "arm_inf" }, AGENT)).status, 403);
    assert.equal((await post("loops.message_all", { message: "  " })).status, 400, "a message is required");
    assert.deepEqual(prompts.held, [], "a refused call types nothing");
    assert.deepEqual(await nextMarker(0), [], "and holds nothing");
});

test("send types the message into the connected agent loops and leaves them unheld", async () => {
    const r = await post("loops.message_all", { message: "stabilise", hold: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results, [
        { consumer_id: "held", prompt: "delivered" },
        { consumer_id: "no-loop", prompt: "delivered" },
    ]);
    assert.deepEqual(prompts.held, ["stabilise"]);
    assert.deepEqual(prompts["no-loop"], ["stabilise"]);
    assert.deepEqual(prompts.boss, [], "a human is not an agent loop");
    assert.deepEqual(prompts.offline, [], "a loop that is gone is not reached");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(markers, [], "no hold without send & hold");
});

test("send & hold also holds each loop indefinitely, and names the one it could not", async () => {
    const r = await post("loops.message_all", { message: "leaving", hold: true });
    assert.equal(r.status, 200);
    const [held, noLoop] = r.json.results!;
    assert.deepEqual(held, { consumer_id: "held", prompt: "delivered", hold: "armed" });
    assert.equal(noLoop!.hold, "failed");
    assert.match(noLoop!.hold_error ?? "", /no claude-loop dir/);
    assert.deepEqual(prompts.held.at(-1), "leaving");
    assert.deepEqual(await nextMarker(1), ["set_afk_inf"]);
});

test("release holds lifts the hold through the same socket", async () => {
    markers.length = 0;
    const r = await post("loops.release_all", {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results![0], { consumer_id: "held", hold: "released" });
    assert.equal(r.json.results![1]!.hold, "failed");
    assert.deepEqual(await nextMarker(1), ["clear_afk"]);
});
