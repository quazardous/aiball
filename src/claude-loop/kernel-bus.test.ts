import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelBus, getKernelBus, bridgeActorToKernel } from "./kernel-bus.js";

test("on/emit delivers the typed payload", () => {
    const bus = new KernelBus();
    let got: number | null = null;
    bus.on("turn:ended", (p) => { got = p.atMs; });
    bus.emit("turn:ended", { atMs: 42 });
    assert.equal(got, 42);
});

test("multiple listeners on the same event all fire", () => {
    const bus = new KernelBus();
    let a = 0, b = 0;
    bus.on("typing:started", () => { a++; });
    bus.on("typing:started", () => { b++; });
    bus.emit("typing:started", { atMs: 1 });
    assert.equal(a, 1);
    assert.equal(b, 1);
});

test("unsubscribe stops delivery", () => {
    const bus = new KernelBus();
    let n = 0;
    const off = bus.on("turn:started", () => { n++; });
    bus.emit("turn:started", { atMs: 1 });
    off();
    bus.emit("turn:started", { atMs: 2 });
    assert.equal(n, 1);
});

test("throw-safe: a throwing listener doesn't break siblings", () => {
    const bus = new KernelBus();
    let reached = false;
    bus.on("boot:sealed", () => { throw new Error("boom"); });
    bus.on("boot:sealed", () => { reached = true; });
    bus.emit("boot:sealed", { loopStartMs: 0, reason: "deadline" });
    assert.equal(reached, true);
});

test("onAny receives every event with its name", () => {
    const bus = new KernelBus();
    const seen: string[] = [];
    bus.onAny((name) => { seen.push(name); });
    bus.emit("turn:ended", { atMs: 1 });
    bus.emit("daemon:ping", { ticketId: 5 });
    assert.deepEqual(seen, ["turn:ended", "daemon:ping"]);
});

test("emit with no listeners is a no-op (does not throw)", () => {
    const bus = new KernelBus();
    assert.doesNotThrow(() => bus.emit("counters:refreshed", { open: 0, backlog: 0, events: 0 }));
});

test("listenerCount tracks per-event and total", () => {
    const bus = new KernelBus();
    const off1 = bus.on("turn:ended", () => {});
    bus.on("turn:ended", () => {});
    bus.on("wake:cleared", () => {});
    bus.onAny(() => {});
    assert.equal(bus.listenerCount("turn:ended"), 2);
    assert.equal(bus.listenerCount(), 4); // 2 + 1 + 1 onAny
    off1();
    assert.equal(bus.listenerCount("turn:ended"), 1);
});

test("getKernelBus returns a stable singleton", () => {
    assert.equal(getKernelBus(), getKernelBus());
});

test("bridgeActorToKernel forwards actor emits onto the bus (end-to-end)", () => {
    const bus = new KernelBus();
    // fake XState actor : records the per-type callbacks .on registers.
    const handlers: Record<string, (ev: unknown) => void> = {};
    const fakeActor = {
        on(type: string, cb: (ev: unknown) => void) { handlers[type] = cb; return () => {}; },
    };
    bridgeActorToKernel(fakeActor as never, ["turn:ended", "turn:settled"], bus);
    let gotEnded: number | null = null;
    let gotSettled: number | null = null;
    bus.on("turn:ended", (p) => { gotEnded = p.atMs; });
    bus.on("turn:settled", (p) => { gotSettled = p.idleSinceMs; });
    // simulate the actor emitting
    handlers["turn:ended"]({ type: "turn:ended", atMs: 7 });
    handlers["turn:settled"]({ type: "turn:settled", idleSinceMs: 99 });
    assert.equal(gotEnded, 7);
    assert.equal(gotSettled, 99);
});

test("bridgeActorToKernel is a no-op on a null actor", () => {
    assert.doesNotThrow(() => bridgeActorToKernel(null, ["turn:ended"], new KernelBus()));
});
