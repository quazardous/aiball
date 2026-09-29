/**
 * #3068 — consumers, loops and launchers as methods: the loop controls stay a
 * human's, and a launcher that cannot start is refused to its caller while
 * the daemon lives on (a spawn failure is an 'error' event: unheard, it ended
 * the daemon, #3103).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3068-loops-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(home, "xdg");
mkdirSync(join(home, "xdg", "aiball"), { recursive: true });
writeFileSync(join(home, "xdg", "aiball", "config.yaml"), [
    "launchers:",
    "  - id: gone",
    `    cmd: ${join(home, "no-such-command")}`,
    "  - id: nowhere",
    "    cmd: /bin/true",
    `    cwd: ${join(home, "no-such-dir")}`,
    "",
].join("\n"));

const { createApp } = await import("../app.js");
const { asToken } = await import("../tests/bus-call.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer, getConsumer } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "doomed", kind: "agent" });
createProject({ name: "p-loops" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "w" }).token;
const BOSS = issueToken({ kind: "auth", consumer_id: "boss", label: "b" }).token;

const tcp = createServer(createApp());
const wss = attachBus(tcp);
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const port = (tcp.address() as { port: number }).port;
const clients: { close(): void }[] = [];
after(() => {
    for (const c of clients) c.close();
    for (const ws of wss.clients) ws.terminate();
    tcp.closeAllConnections();
    tcp.close();
    rmSync(home, { recursive: true, force: true });
});

async function as(token: string) {
    const c = await BusClient.connect({ url: `http://127.0.0.1:${port}`, token });
    clients.push(c);
    return c;
}

const code = (c: string) => (e: { code: string }) => e.code === c;
const status = (n: number) => (e: { status: number }) => e.status === n;

test("the loop controls are a human's; with no loop running they reach nobody", async () => {
    const boss = await as(BOSS);
    const w = await as(WORKER);
    for (const [m, p] of [
        ["consumer.stop_loop", { consumer_id: "worker" }],
        ["consumer.prompt", { consumer_id: "worker", text: "hi" }],
        ["loops.message_all", { message: "hi" }],
        ["loops.release_all", {}],
    ] as const) {
        await assert.rejects(w.call(m, p), code("MODERATOR_ONLY"), m);
    }

    assert.equal((await boss.call<{ delivered: boolean }>("consumer.stop_loop", { consumer_id: "worker" })).delivered, false);
    const prompt = await boss.call<{ spooled: boolean; delivered: boolean }>("consumer.prompt", { consumer_id: "worker", text: "hi" });
    assert.deepEqual([prompt.spooled, prompt.delivered], [true, false]);
    await assert.rejects(boss.call("consumer.prompt", { consumer_id: "worker", text: "  " }), status(400));
    assert.deepEqual((await boss.call<{ results: unknown[] }>("loops.message_all", { message: "hi" })).results, []);
    assert.deepEqual(await boss.call("loops.release_all", {}), JSON.parse(JSON.stringify((await asToken(BOSS, "loops.release_all", {})).json)), "the connection answers as a direct call");
});

test("a consumer's wait credit and deletion", async () => {
    const boss = await as(BOSS);
    const credit = await boss.call<{ credits: unknown[] | null; moves: unknown[] }>("consumer.wait_credit", { consumer_id: "worker" });
    assert.ok(Array.isArray(credit.credits) && Array.isArray(credit.moves));
    assert.equal((await boss.call<{ credits: unknown }>("consumer.wait_credit", { consumer_id: "boss" })).credits, null, "a human has none");
    assert.deepEqual(await boss.call("consumer.delete", { consumer_id: "doomed" }), { consumer_id: "doomed", deleted: true });
    assert.equal(getConsumer("doomed"), null);
    await assert.rejects(boss.call("consumer.delete", { consumer_id: "doomed" }), code("CONSUMER_NOT_FOUND"));
});

test("launchers and launch: a human's; one that cannot start is refused, and the daemon lives on", async () => {
    const boss = await as(BOSS);
    const w = await as(WORKER);
    const listed = await boss.call<Array<{ id: string }>>("launcher.list", {});
    assert.deepEqual(listed.map((l) => l.id), ["gone", "nowhere"]);
    await assert.rejects(w.call("launcher.run", { id: "gone" }), code("MODERATOR_ONLY"));
    await assert.rejects(boss.call("launcher.run", { id: "unknown" }), status(404));

    await assert.rejects(boss.call("launcher.run", { id: "gone" }), status(500));
    await assert.rejects(boss.call("launcher.run", { id: "nowhere" }), status(500));
    // The 'error' events land after the answer: let them, then ask again.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await boss.call<unknown[]>("launcher.list", {})).length, 2, "still answering");

    await assert.rejects(w.call("project.launch", { name: "p-loops", root: "/tmp" }), code("MODERATOR_ONLY"));
    await assert.rejects(boss.call("project.launch", { name: "p-loops", root: "/tmp" }), status(400), "not one of its roots");
});
