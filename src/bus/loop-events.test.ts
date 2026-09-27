/**
 * #3068 — a loop's events over the bus, through the client the loop uses
 * (`subscribeEvents`): the hello, pings, controls and signals the event stream
 * carried; the waiting signals and spooled prompts first; the subscription as
 * the loop's liveness; and the end of it reported once, for the loop to
 * reconnect.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3068-events-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.AIBALL_PRESENCE_GRACE_MS = "20";

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { issueToken } = await import("../db/tokens.js");
const { AiballClient } = await import("../client.js");
const { emitControl, emitPing } = await import("../event-bus.js");
const { postSignal } = await import("../db/signals.js");
const { spoolPrompt } = await import("../loop-prompts.js");
const { isPresent, presenceRunning } = await import("../live-presence.js");

upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "w" }).token;

const tcp = createServer(createApp());
const wss = attachBus(tcp);
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(tcp.address() as { port: number }).port}`;
after(() => {
    for (const ws of wss.clients) ws.terminate();
    tcp.closeAllConnections();
    tcp.close();
    rmSync(home, { recursive: true, force: true });
});

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

test("hello, the waiting signal and prompt first, then pings and controls; the subscription is the loop's liveness", async () => {
    postSignal({ source: "ci", target: { consumer: "worker" }, title: "build red" });
    spoolPrompt("worker", "spooled while away");

    const client = new AiballClient({ url, token: WORKER, agentId: "worker" });
    const got: string[] = [];
    let hello: { unread: number } | null = null;
    const errors: Error[] = [];
    const stop = client.subscribeEvents({
        onHello: (h) => { hello = h; },
        onPing: (p) => got.push(`ping:${p.ticket_id}`),
        onControl: (c) => got.push(`control:${c.action}${"text" in c ? `:${c.text}` : ""}`),
        onSignal: (s) => got.push(`signal:${s.title}`),
        onError: (e) => errors.push(e),
    });
    await until("the hello", () => hello !== null);
    await until("what waited", () => got.length >= 2);
    assert.deepEqual(got.slice(0, 2).sort(), ["control:prompt:spooled while away", "signal:build red"]);
    assert.equal(isPresent("worker"), true, "subscribed: the loop is running");

    emitPing("worker", { ticket_id: 42, intent: "request" });
    emitControl("worker", { action: "kill" });
    emitControl("other", { action: "kill" });
    await until("the ping and the control", () => got.length >= 4);
    assert.deepEqual(got.slice(2), ["ping:42", "control:kill"], "another consumer's events never reach it");

    stop();
    await until("the loop seen gone", () => presenceRunning("worker") === false);
    assert.deepEqual(errors, [], "stopping on purpose is not an error");
});

test("the daemon ending the connection is one error, for the loop to reconnect", async () => {
    const client = new AiballClient({ url, token: WORKER, agentId: "worker" });
    let hello = false;
    const errors: Error[] = [];
    const stop = client.subscribeEvents({ onHello: () => { hello = true; }, onPing: () => {}, onError: (e) => errors.push(e) });
    await until("the hello", () => hello);
    for (const ws of wss.clients) ws.terminate();
    await until("the error", () => errors.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(errors.length, 1, "reported once");
    stop();
});

test("another consumer's events are refused", async () => {
    const client = new AiballClient({ url, token: WORKER, agentId: "other" });
    const errors: Error[] = [];
    client.subscribeEvents({ onPing: () => {}, onError: (e) => errors.push(e) });
    await until("the refusal", () => errors.length > 0);
    assert.match(errors[0].message, /own events|403/);
});
