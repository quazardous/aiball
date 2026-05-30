/**
 * #628 — WakeBus unit tests. Uses a mock AiballClient (just enough surface
 * for `subscribeEvents`) so the bus is exercised without a live daemon.
 */
import { test } from "node:test";
import assert from "node:assert";
import { WakeBus, type ControlEvent, type PingHint, type HelloEvent } from "./wake-bus.js";

interface CapturedHandlers {
    onPing?: (p: { ticket_id?: number; intent?: string }) => void;
    onHello?: (h: { consumer_id: string; unread: number }) => void;
    onControl?: (c: { action: string; [k: string]: unknown }) => void;
    onError?: (e: Error) => void;
}

/** Mock that captures the handler set passed to `subscribeEvents` so the
 *  test can drive events manually. */
function mockClient(): {
    client: import("../client.js").AiballClient;
    handlers: CapturedHandlers;
    unsubscribed: { count: number };
} {
    const handlers: CapturedHandlers = {};
    const unsubscribed = { count: 0 };
    const client = {
        subscribeEvents: (h: CapturedHandlers) => {
            handlers.onPing = h.onPing;
            handlers.onHello = h.onHello;
            handlers.onControl = h.onControl;
            handlers.onError = h.onError;
            return () => { unsubscribed.count++; };
        },
    } as unknown as import("../client.js").AiballClient;
    return { client, handlers, unsubscribed };
}

test("#628 WakeBus: ping event fires registered listeners", () => {
    const { client, handlers } = mockClient();
    const bus = new WakeBus(client);
    bus.connect();
    const seen: PingHint[] = [];
    bus.on("ping", (p) => seen.push(p));
    handlers.onPing!({ ticket_id: 42, intent: "request" });
    handlers.onPing!({ ticket_id: 43, intent: "panic" });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].ticket_id, 42);
    assert.equal(seen[1].intent, "panic");
});

test("#628 WakeBus: control event fires listeners (kill, prompt)", () => {
    const { client, handlers } = mockClient();
    const bus = new WakeBus(client);
    bus.connect();
    const seen: ControlEvent[] = [];
    bus.on("control", (c) => seen.push(c));
    handlers.onControl!({ action: "kill" });
    handlers.onControl!({ action: "prompt", text: "hello" });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].action, "kill");
    assert.equal((seen[1] as { text: string }).text, "hello");
});

test("#628 WakeBus: hello event fires listeners with unread count", () => {
    const { client, handlers } = mockClient();
    const bus = new WakeBus(client);
    bus.connect();
    const seen: HelloEvent[] = [];
    bus.on("hello", (h) => seen.push(h));
    handlers.onHello!({ consumer_id: "agent", unread: 7 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].unread, 7);
});

test("#628 WakeBus: error event fires listeners + drops connection state", () => {
    const { client, handlers } = mockClient();
    const bus = new WakeBus(client);
    bus.connect();
    assert.equal(bus.isConnected(), true);
    const seen: Error[] = [];
    bus.on("error", (e) => seen.push(e));
    handlers.onError!(new Error("boom"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].message, "boom");
    assert.equal(bus.isConnected(), false);
});

test("#628 WakeBus: unsubscribe handle removes only the targeted listener", () => {
    const { client, handlers } = mockClient();
    const bus = new WakeBus(client);
    bus.connect();
    const a: PingHint[] = [];
    const b: PingHint[] = [];
    const offA = bus.on("ping", (p) => a.push(p));
    bus.on("ping", (p) => b.push(p));
    handlers.onPing!({ ticket_id: 1 });
    offA();
    handlers.onPing!({ ticket_id: 2 });
    assert.equal(a.length, 1);
    assert.equal(b.length, 2);
});

test("#628 WakeBus: throttle skips connect calls within throttleMs window", () => {
    let subscribeCalls = 0;
    const client = {
        subscribeEvents: () => { subscribeCalls++; return () => { /* */ }; },
    } as unknown as import("../client.js").AiballClient;
    const bus = new WakeBus(client, { throttleMs: 10_000 });
    bus.connect();   // 1st : opens
    bus.connect();   // 2nd : throttled
    bus.connect();   // 3rd : throttled
    assert.equal(subscribeCalls, 1);
});

test("#628 WakeBus: listener throwing doesn't break the bus", () => {
    const { client, handlers } = mockClient();
    const bus = new WakeBus(client);
    bus.connect();
    let nextCalled = false;
    bus.on("ping", () => { throw new Error("listener crashed"); });
    bus.on("ping", () => { nextCalled = true; });
    handlers.onPing!({ ticket_id: 99 });
    assert.equal(nextCalled, true, "second listener must still fire after the first throws");
});

test("#628 WakeBus: close() unsubscribes from upstream + clears listeners", () => {
    const { client, handlers, unsubscribed } = mockClient();
    const bus = new WakeBus(client);
    bus.connect();
    const seen: PingHint[] = [];
    bus.on("ping", (p) => seen.push(p));
    assert.equal(bus.isConnected(), true);
    bus.close();
    assert.equal(unsubscribed.count, 1);
    assert.equal(bus.isConnected(), false);
    // After close, handlers stored in the mock are still callable, but
    // the bus won't forward them anymore.
    handlers.onPing!({ ticket_id: 1 });
    assert.equal(seen.length, 0);
});
